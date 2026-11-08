import assert from "node:assert/strict";
import { spawn, fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, open } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
    connect,
    consumerOpts,
    RetentionPolicy,
    StorageType,
    StringCodec,
} from "nats";
import { resolveRuntimeLayout } from "./runtime-manifest.mjs";
import { inspectStorage } from "./storage-probe.mjs";
import { formatFailureEvidence } from "./failure-evidence.mjs";
import { validateScenario, SCENARIO_KIND } from "./scenario-contract.mjs";
import {
    QUALIFICATION_PROTOCOL_PREFIX,
    QUALIFICATION_PROTOCOL_VERSION,
    QUALIFICATION_EVENT,
    QUALIFICATION_STATUS,
    QUALIFICATION_CHECK as CHECK,
    SIMULATION_EVIDENCE_PREFIX,
    SIMULATION_EVIDENCE_EVENT,
} from "../qualification-protocol.mjs";
const CHILD_MODE = "--qualification-child";
const root = process.env.ARTGOD_WORKBENCH_ROOT ?? "/workbench";
const layout = resolveRuntimeLayout(root);
const state = path.join(root, "state");
const output = path.join(root, "output");
const codec = StringCodec();
let activeScenario;
const activeChildren = new Set();

function sqlite(filename) {
    const Database = createRequire(layout.sqliteIssuer)("better-sqlite3");
    const connection = new Database(filename);
    connection.pragma("busy_timeout = 10000");
    return connection;
}

function emit(message) {
    process.stdout.write(
        `${QUALIFICATION_PROTOCOL_PREFIX}${JSON.stringify({ version: QUALIFICATION_PROTOCOL_VERSION, qualificationId: activeScenario.qualificationId, ...message })}\n`,
    );
}

async function eventually(check, label, timeoutMs = 30_000) {
    const startedAt = Date.now();
    while (!(await check())) {
        if (Date.now() - startedAt >= timeoutMs)
            throw new Error(`Guest timeout: ${label}`);
        await delay(20);
    }
}

function watchChild(child) {
    activeChildren.add(child);
    child.once("exit", () => activeChildren.delete(child));
    const messages = [];
    let failure;
    let exited = false;
    const completion = new Promise((resolve) => {
        child.once("error", (error) => {
            failure = error;
            exited = true;
            resolve();
        });
        child.once("exit", (code, signal) => {
            exited = true;
            if (code !== 0 && signal !== "SIGKILL")
                failure = new Error(`Guest child failed: ${code ?? signal}`);
            resolve();
        });
    });
    child.on("message", (message) => messages.push(message));
    return {
        child,
        messages,
        completion,
        async wait(event) {
            await eventually(() => {
                if (failure) throw failure;
                if (messages.some((message) => message.event === event))
                    return true;
                if (exited) throw new Error(`Child exited before ${event}`);
                return false;
            }, `child ${event}`);
            return messages.find((message) => message.event === event);
        },
    };
}

async function childWorker(role, config) {
    const log = await open(path.join(output, `${role}.log`), "w");
    try {
        return watchChild(
            fork(
                fileURLToPath(import.meta.url),
                [CHILD_MODE, role, JSON.stringify(config)],
                {
                    env: { ...process.env, ARTGOD_WORKBENCH_ROOT: root },
                    stdio: ["ignore", log.fd, log.fd, "ipc"],
                },
            ),
        );
    } finally {
        await log.close();
    }
}

async function runSqliteWriter(role, config) {
    const database = sqlite(config.database);
    process.send({ event: "ready" });
    await new Promise((resolve) => process.once("message", resolve));
    try {
        const startedAt = Date.now();
        process.send({ event: "attempting" });
        database.exec("BEGIN IMMEDIATE");
        const waitedMs = Date.now() - startedAt;
        if (role === "writer-first") {
            process.send({ event: "locked" });
            // Keep a real write transaction open while another process tries its writer.
            await new Promise((resolve) => process.once("message", resolve));
        }
        const insert = database.prepare(
            "INSERT INTO writes(id, writer) VALUES (?, ?)",
        );
        const increment = database.prepare(
            "UPDATE counters SET value = value + 1 WHERE id = 1",
        );
        for (let index = 0; index < config.count; index++) {
            insert.run(`${role}:${index}`, role);
            increment.run();
        }
        database.exec("COMMIT");
        process.send({ event: "committed", count: config.count, waitedMs });
    } finally {
        database.close();
        process.disconnect();
    }
}

async function runNatsConsumer(config) {
    const database = sqlite(config.database);
    const connection = await connect({
        servers: config.natsUrl,
        reconnect: false,
    });
    const jetstream = connection.jetstream();
    const options = consumerOpts();
    options.durable("qualification-consumer");
    options.manualAck();
    options.ackExplicit();
    options.deliverAll();
    options.ackWait(1000);
    options.maxAckPending(1);
    const subscription = await jetstream.pullSubscribe(
        "qualification.jobs",
        options,
    );
    let processed = 0;
    let duplicates = 0;
    const persist = database.transaction(
        (id) =>
            database
                .prepare("INSERT OR IGNORE INTO deliveries(id) VALUES (?)")
                .run(id).changes,
    );
    process.send({ event: "ready" });
    try {
        while (processed < config.count) {
            const fetched = jetstream.fetch(
                "QUALIFICATION",
                "qualification-consumer",
                { batch: 1, expires: 2000 },
            );
            for await (const message of fetched) {
                const id = codec.decode(message.data);
                const changed = persist(id);
                if (!changed) duplicates++;
                processed++;
                if (config.holdAfterCommit) {
                    process.send({ event: "committed-before-ack", id });
                    // The parent kills this actual process at the durable boundary.
                    await new Promise(() => {});
                }
                message.ack();
            }
        }
        await connection.flush();
        process.send({ event: "complete", processed, duplicates });
    } finally {
        subscription.unsubscribe();
        await connection.close();
        database.close();
        process.disconnect();
    }
}

async function startBroker() {
    const store = path.join(state, "jetstream");
    const config = path.join(state, "nats.conf");
    await mkdir(store, { recursive: true });
    await writeFile(
        config,
        `host: "127.0.0.1"\nport: 4222\njetstream { store_dir: ${JSON.stringify(store)}, max_file_store: 67108864 }\n`,
    );
    const log = await open(path.join(output, "nats.log"), "a");
    const child = spawn(layout.natsBinary, ["-c", config], {
        stdio: ["ignore", log.fd, log.fd],
    });
    await log.close();
    let startupError;
    child.once("error", (error) => {
        startupError = error;
    });
    let connection;
    try {
        await eventually(async () => {
            if (startupError) throw startupError;
            if (child.exitCode !== null)
                throw new Error(`NATS exited: ${child.exitCode}`);
            try {
                connection = await connect({
                    servers: "nats://127.0.0.1:4222",
                    reconnect: false,
                    timeout: 500,
                });
                return true;
            } catch {
                return false;
            }
        }, "private NATS startup");
        return { child, connection, url: "nats://127.0.0.1:4222" };
    } catch (error) {
        child.kill("SIGKILL");
        throw error;
    }
}

async function stopProcess(child, signal = "SIGTERM") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise((resolve, reject) => {
        child.once("exit", resolve);
        child.once("error", reject);
    });
    child.kill(signal);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
        await stopped;
    } finally {
        clearTimeout(timeout);
    }
}

async function stopBroker(broker) {
    await broker.connection.close();
    await stopProcess(broker.child);
}

async function qualification() {
    await mkdir(state, { recursive: true });
    await mkdir(output, { recursive: true });
    const databasePath = path.join(state, "qualification.sqlite");
    const database = sqlite(databasePath);
    let knownAnswers;
    try {
        // The stage owner and SDK load only after ready/probe. An initialization
        // fault must remain a named substrate failure with prior evidence.
        const { qualifyRuntimeKnownAnswers } =
            await import("./runtime-known-answers.mjs");
        knownAnswers = await qualifyRuntimeKnownAnswers(database);
        const native = await qualifyNativeQueues(database, databasePath);
        return {
            evidence: { ...native, runtimeKnownAnswers: knownAnswers.evidence },
            checks: {
                ...knownAnswers.checks,
                [CHECK.SqliteWal]: true,
                [CHECK.SqliteCompetingWriters]: true,
                [CHECK.SqliteReopen]: true,
                [CHECK.NatsPersistentRestart]: true,
                [CHECK.NatsRedeliveryAfterCommit]: true,
                [CHECK.GuestEntropyClock]: true,
            },
        };
    } catch (error) {
        if (knownAnswers)
            error.simulation = {
                ...(error.simulation ?? {}),
                checks: { ...knownAnswers.checks, ...error.simulation?.checks },
                runtimeKnownAnswers: knownAnswers.evidence,
            };
        throw error;
    } finally {
        if (database.open) database.close();
    }
}

async function qualifyNativeQueues(database, databasePath) {
    assert.equal(
        database.pragma("journal_mode = WAL", { simple: true }),
        "wal",
    );
    database.exec(
        "CREATE TABLE counters(id INTEGER PRIMARY KEY, value INTEGER NOT NULL); INSERT INTO counters VALUES(1,0); CREATE TABLE writes(id TEXT PRIMARY KEY, writer TEXT NOT NULL); CREATE TABLE deliveries(id TEXT PRIMARY KEY);",
    );
    const first = await childWorker("writer-first", {
        database: databasePath,
        count: 16,
    });
    const second = await childWorker("writer-second", {
        database: databasePath,
        count: 16,
    });
    await Promise.all([first.wait("ready"), second.wait("ready")]);
    first.child.send({ event: "start" });
    await first.wait("locked");
    second.child.send({ event: "start" });
    await second.wait("attempting");
    await delay(50);
    first.child.send({ event: "release" });
    const [, competingCommit] = await Promise.all([
        first.wait("committed"),
        second.wait("committed"),
    ]);
    assert.ok(
        competingCommit.waitedMs > 0,
        "The competing writer must wait for SQLite's real write lock",
    );
    await Promise.all([first.completion, second.completion]);
    assert.equal(
        database.prepare("SELECT value FROM counters WHERE id=1").get().value,
        32,
    );
    assert.equal(
        database.prepare("SELECT count(*) AS count FROM writes").get().count,
        32,
    );
    database.close();

    let broker = await startBroker();
    const children = [];
    try {
        const manager = await broker.connection.jetstreamManager();
        await manager.streams.add({
            name: "QUALIFICATION",
            subjects: ["qualification.jobs"],
            retention: RetentionPolicy.Workqueue,
            storage: StorageType.File,
        });
        for (let index = 0; index < 8; index++)
            await broker.connection
                .jetstream()
                .publish(
                    "qualification.jobs",
                    codec.encode(`message:${index}`),
                    { msgID: `qualification:${index}` },
                );
        const interrupted = await childWorker("consumer-interrupted", {
            database: databasePath,
            natsUrl: broker.url,
            count: 1,
            holdAfterCommit: true,
        });
        children.push(interrupted);
        const committed = await interrupted.wait("committed-before-ack");
        assert.equal(committed.id, "message:0");
        await stopProcess(interrupted.child, "SIGKILL");
        await stopBroker(broker);
        broker = await startBroker();
        const resumed = await childWorker("consumer-resumed", {
            database: databasePath,
            natsUrl: broker.url,
            count: 8,
        });
        children.push(resumed);
        const receipt = await resumed.wait("complete");
        await resumed.completion;
        assert.equal(receipt.processed, 8);
        assert.equal(receipt.duplicates, 1);
        const reopened = sqlite(databasePath);
        try {
            assert.equal(
                reopened
                    .prepare("SELECT count(*) AS count FROM deliveries")
                    .get().count,
                8,
            );
            assert.equal(
                reopened.prepare("SELECT value FROM counters WHERE id=1").get()
                    .value,
                32,
            );
            assert.equal(
                reopened.pragma("integrity_check", { simple: true }),
                "ok",
            );
        } finally {
            reopened.close();
        }
        await eventually(
            async () =>
                (
                    await (
                        await broker.connection.jetstreamManager()
                    ).streams.info("QUALIFICATION")
                ).state.messages === 0,
            "durable ACK completion",
        );
        return {
            sqlite: {
                journalMode: "wal",
                concurrentWriters: 2,
                committedWrites: 32,
                reopened: true,
                integrity: "ok",
            },
            nats: {
                storage: "file",
                restart: true,
                published: 8,
                committedBeforeAck: 1,
                deliveredAfterRestart: 8,
                deduplicatedDatabaseEffects: 1,
                pendingMessages: 0,
            },
        };
    } finally {
        for (const child of children) await stopProcess(child.child, "SIGKILL");
        await stopBroker(broker);
    }
}

async function main() {
    const scenarioPath = process.argv[2] ?? path.join(root, "scenario.json");
    const scenario = validateScenario(
        JSON.parse(await readFile(scenarioPath, "utf8")),
    );
    activeScenario = scenario;
    const dataPlane =
        scenario.kind === SCENARIO_KIND.DataPlane
            ? await import("./data-plane.mjs")
            : undefined;
    emit({ event: QUALIFICATION_EVENT.Ready });
    const probe = {
        pid: process.pid,
        now: Date.now(),
        entropy: randomBytes(16).toString("hex"),
        storage: await inspectStorage(),
    };
    process.stdout.write(
        `${SIMULATION_EVIDENCE_PREFIX}${JSON.stringify({ [SIMULATION_EVIDENCE_EVENT.Probe]: probe })}\n`,
    );
    const result = dataPlane
        ? await dataPlane.runDataPlane(scenario, {
              root,
              layout,
              state,
              output,
              eventually,
              startBroker,
              stopBroker,
              stopProcess,
          })
        : await qualification();
    const { evidence } = result;
    evidence.storage = { before: probe.storage, after: await inspectStorage() };
    const checks = Object.fromEntries(
        scenario.expectedChecks.map((check) => [
            check,
            result.checks[check] === true,
        ]),
    );
    await writeFile(
        path.join(output, "result.json"),
        `${JSON.stringify({ version: 1, qualificationId: scenario.qualificationId, probe, checks, evidence }, null, 2)}\n`,
    );
    process.stdout.write(
        `${SIMULATION_EVIDENCE_PREFIX}${JSON.stringify({ [SIMULATION_EVIDENCE_EVENT.Result]: { checks, evidence } })}\n`,
    );
    emit({
        event: QUALIFICATION_EVENT.Complete,
        status: Object.values(checks).every(Boolean)
            ? QUALIFICATION_STATUS.Passed
            : QUALIFICATION_STATUS.Failed,
        checks,
    });
}

if (process.argv[2] === CHILD_MODE) {
    const role = process.argv[3];
    const config = JSON.parse(process.argv[4]);
    const task = role.startsWith("writer-")
        ? runSqliteWriter(role, config)
        : runNatsConsumer(config);
    task.catch((error) => {
        process.stderr.write(`${error.stack ?? String(error)}\n`);
        process.exitCode = 1;
        process.disconnect?.();
    });
} else {
    main().catch(async (error) => {
        for (const child of activeChildren) await stopProcess(child, "SIGKILL");
        const evidence = formatFailureEvidence(
            error,
            activeScenario?.expectedChecks ?? [],
        );
        const { checks } = evidence;
        process.stdout.write(
            `${SIMULATION_EVIDENCE_PREFIX}${JSON.stringify({ [SIMULATION_EVIDENCE_EVENT.Failure]: evidence })}\n`,
        );
        await mkdir(output, { recursive: true });
        await writeFile(
            path.join(output, "failure.json"),
            `${JSON.stringify(evidence, null, 2)}\n`,
        );
        if (activeScenario?.qualificationId)
            emit({
                event: QUALIFICATION_EVENT.Complete,
                status: QUALIFICATION_STATUS.Failed,
                checks,
            });
        process.stderr.write(`${error.stack ?? String(error)}\n`);
        // A completed failed property must still power off normally so the host
        // can replay the counterexample and distinguish it from emulator failure.
        process.exitCode = activeScenario ? 0 : 1;
    });
}
