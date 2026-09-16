// Maintained native/API integration harness. Every store is synthetic and kept
// under this worktree's tmp/. No application config, wallet or database is loaded.
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
    cp,
    mkdir,
    mkdtemp,
    open,
    readdir,
    stat,
    writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import {
    AckPolicy,
    DeliverPolicy,
    RetentionPolicy,
    StorageType,
    connect,
    type NatsConnection,
} from "nats";
import {
    NATS_JOB_STREAM_MAX_AGE_NANOS,
    resolveNatsJobStreamName,
    resolveNatsJobStreamSubjectFilter,
    resolveNatsJobSubject,
} from "@artgod/shared/queue/nats-job-stream";
import {
    MaintainNatsJobStream,
    planAcknowledgedJobStreamCleanup,
} from "../src/application/queue/maintain-nats-job-stream.js";
import { NatsJobStreamMaintenanceAdapter } from "../src/infra/queue/nats-job-stream-maintenance.js";
import { DEFAULT_DESKTOP_NATS_VERSION } from "../../scripts/build/native-runtime-dependencies.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const exec = promisify(execFile);
const prefix = "preservation-fixture";
const stream = resolveNatsJobStreamName(prefix);
const subject = (queue: string) => resolveNatsJobSubject(prefix, queue);
const natsBinary = path.join(
    root,
    "src-tauri/resources/runtime/nats",
    process.platform === "win32" ? "nats-server.exe" : "nats-server",
);
const artifactRoot = path.join(root, "tmp/nats-startup-recovery");
await mkdir(artifactRoot, { recursive: true });
const artifacts = await mkdtemp(path.join(artifactRoot, "run-"));
const environment = { ...process.env, TMPDIR: artifacts };
const manifest = path.join(root, "src-tauri/Cargo.toml");
const metadata = JSON.parse(
    (
        await exec(
            "cargo",
            [
                "metadata",
                "--manifest-path",
                manifest,
                "--locked",
                "--offline",
                "--no-deps",
                "--format-version",
                "1",
            ],
            { cwd: root, env: environment },
        )
    ).stdout,
);
const nativePackage = metadata.packages.find(
    (p: { manifest_path: string }) =>
        path.resolve(p.manifest_path) === manifest,
);
const nativeTarget = nativePackage.targets.find((target: { kind: string[] }) =>
    target.kind.includes("bin"),
);
assert(nativeTarget, "Native desktop target is required");
const nativeBinary = path.join(
    metadata.target_directory,
    "debug",
    nativeTarget.name + (process.platform === "win32" ? ".exe" : ""),
);
console.log("Building the native preparation child…");
const build = await exec(
    "cargo",
    [
        "build",
        "--manifest-path",
        manifest,
        "--locked",
        "--offline",
        "--bin",
        nativeTarget.name,
    ],
    { cwd: root, env: environment, maxBuffer: 16 * 1024 * 1024 },
);
await writeFile(
    path.join(artifacts, "native-build.log"),
    build.stdout + build.stderr,
);
assert(
    (await exec(natsBinary, ["--version"])).stdout.includes(
        DEFAULT_DESKTOP_NATS_VERSION,
    ),
    "Use the project's pinned NATS fixture binary",
);

const results: string[] = [];
const active = new Set<Broker>();

async function verifyOfflineAgeMigration() {
    const store = path.join(artifacts, "legacy");
    let broker = await Broker.start(store);
    await broker.manager.streams.add({
        name: stream,
        subjects: [resolveNatsJobStreamSubjectFilter(prefix)],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        max_age: 1_000_000_000,
    });
    const saved = await broker.client.publish(
        subject("valid"),
        new TextEncoder().encode("legitimate unfinished job"),
    );
    await broker.stop();
    const control = path.join(artifacts, "legacy-unmigrated-control");
    await cp(store, control, { recursive: true });
    await delay(1_300); // Real expiry, scaled to a short age limit; no broker runs during this wait.
    await prepare(store);
    broker = await Broker.start(store);
    assert.equal(
        (await broker.manager.streams.info(stream)).config.max_age,
        NATS_JOB_STREAM_MAX_AGE_NANOS,
    );
    assert.equal(
        (
            await broker.manager.streams.getMessage(stream, { seq: saved.seq })
        ).string(),
        "legitimate unfinished job",
    );
    assert.equal((await maintain(broker)).purged, false);
    await assert.rejects(
        () => prepare(store, broker.port),
        /already listening/,
    );
    await broker.stop();
    await prepare(store); // Idempotent retry/restart.
    broker = await Broker.start(store);
    await broker.manager.consumers.add(stream, {
        durable_name: "valid",
        filter_subject: subject("valid"),
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
    });
    const consumer = await broker.client.consumers.get(stream, "valid");
    const next = await consumer.next({ expires: 1_000 });
    assert(
        next,
        "Old valid job must still be available for processing after a second restart",
    );
    assert.equal(next.string(), "legitimate unfinished job");
    assert(await next.ackAck());
    assert.equal(
        (await maintain(broker)).purged,
        false,
        "An empty healthy consumer needs no retained-message cleanup",
    );
    await broker.stop();
    const unmigrated = await Broker.start(control);
    assert.equal(
        (await unmigrated.manager.streams.info(stream)).state.messages,
        0,
        "Control proves NATS expires saved jobs during restore before API maintenance",
    );
    await unmigrated.stop();
    results.push(
        "legacy age migration preserves an expired-by-old-policy job across two restarts and actual consumption",
        "unmigrated control demonstrates pre-API expiry",
        "preparation refuses a live NATS listener",
    );
}

async function verifySelectiveCleanup() {
    const original = path.join(artifacts, "mixed-original");
    let broker = await Broker.start(original);
    await broker.manager.streams.add({
        name: stream,
        subjects: [resolveNatsJobStreamSubjectFilter(prefix)],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        max_age: NATS_JOB_STREAM_MAX_AGE_NANOS,
    });
    for (const queue of ["completed", "inflight", "healthy"]) {
        await broker.manager.consumers.add(stream, {
            durable_name: queue,
            filter_subject: subject(queue),
            ack_policy: AckPolicy.Explicit,
            deliver_policy: DeliverPolicy.All,
            ack_wait: 60_000_000_000,
        });
    }
    // Enough bounded synthetic payload to span multiple 4 MiB workqueue blocks.
    const completedCount = 24;
    const protectedMessages = new Map<number, string>();
    const queues = [
        ...Array.from({ length: completedCount + 2 }, () => "completed"),
        "inflight",
        "healthy",
        "healthy",
        "unowned",
    ];
    for (const queue of queues) {
        const label = `${queue}-${protectedMessages.size}`;
        const value =
            queue === "completed" ? label.padEnd(512 * 1024, "x") : label;
        const ack = await broker.client.publish(
            subject(queue),
            new TextEncoder().encode(value),
        );
        protectedMessages.set(ack.seq, value);
    }
    await broker.stop();
    const beforeAck = path.join(artifacts, "mixed-before-ack");
    await cp(original, beforeAck, { recursive: true });
    broker = await Broker.start(original);
    const done = await broker.client.consumers.get(stream, "completed");
    for (let i = 0; i < completedCount; i++) {
        const message = await done.next({ expires: 1_000 });
        assert(message);
        assert(await message.ackAck()); // These records really were delivered and acknowledged.
        protectedMessages.delete(message.seq);
    }
    const inflight = await broker.client.consumers.get(stream, "inflight");
    assert(await inflight.next({ expires: 1_000 })); // Intentionally unacknowledged.
    const completedInfo = await broker.manager.consumers.info(
        stream,
        "completed",
    );
    assert.equal(completedInfo.num_pending, 2);
    assert.equal(completedInfo.num_ack_pending, 0);
    await broker.stop();

    // Reconstruct the observed invariant, not the unknown original defect:
    // real acknowledged consumer state plus its earlier retained message blocks.
    // Both input snapshots are preserved. Only a new synthetic store is assembled.
    const reconstructed = path.join(artifacts, "mixed-retained");
    const messagesRelative = path.join(
        "jetstream",
        "$G",
        "streams",
        stream,
        "msgs",
    );
    const messageSource = path.join(original, messagesRelative);
    await cp(original, reconstructed, {
        recursive: true,
        filter: (source) => source !== messageSource,
    });
    await cp(
        path.join(beforeAck, messagesRelative),
        path.join(reconstructed, messagesRelative),
        { recursive: true },
    );
    await prepare(reconstructed);
    broker = await Broker.start(reconstructed);
    const adapter = await NatsJobStreamMaintenanceAdapter.connect({
        natsUrl: broker.url,
        streamPrefix: prefix,
    });
    try {
        const initial = await adapter.inspect();
        await writeFile(
            path.join(artifacts, "mixed-before.json"),
            JSON.stringify(initial, null, 2),
        );
        assert.equal(initial.stream?.messages, queues.length);
        const diskBefore = await messageDiskUsage(
            path.join(reconstructed, messagesRelative),
        );
        const planned = planAcknowledgedJobStreamCleanup(initial);
        assert.equal(planned.length, 1);
        assert.equal(planned[0]!.subject, subject("completed"));
        assert.equal(
            planned[0]!.throughSequence,
            completedInfo.ack_floor.stream_seq,
        );
        const result = await new MaintainNatsJobStream(adapter, {
            report: () => {},
        }).execute();
        assert.equal(result.purgedMessages, completedCount);
        const diskAfter = await messageDiskUsage(
            path.join(reconstructed, messagesRelative),
        );
        assert(
            diskAfter.bytes < diskBefore.bytes / 2,
            "Completed message blocks must actually release disk space",
        );
        if (diskBefore.allocatedBytes > 0)
            assert(diskAfter.allocatedBytes < diskBefore.allocatedBytes / 2);
        await writeFile(
            path.join(artifacts, "disk-reclamation.json"),
            JSON.stringify({ before: diskBefore, after: diskAfter }, null, 2),
        );
        assert.equal(result.final.stream?.messages, protectedMessages.size);
        for (const [seq, value] of protectedMessages) {
            assert.equal(
                (
                    await broker.manager.streams.getMessage(stream, { seq })
                ).string(),
                value,
            );
        }
        assert.equal(
            (await broker.manager.consumers.info(stream, "completed"))
                .num_pending,
            2,
        );
        assert.equal(
            (await broker.manager.consumers.info(stream, "inflight"))
                .num_ack_pending,
            1,
        );
        assert.equal(
            (await broker.manager.consumers.info(stream, "healthy"))
                .num_pending,
            2,
        );
        assert.equal(
            (
                await new MaintainNatsJobStream(adapter, {
                    report: () => {},
                }).execute()
            ).purgedMessages,
            0,
        );
        await writeFile(
            path.join(artifacts, "mixed-after.json"),
            JSON.stringify(result.final, null, 2),
        );
    } finally {
        await adapter.close();
    }
    await broker.stop();
    results.push(
        "mixed retained store removes only previously acknowledged records and releases physical disk blocks",
        "pending, in-flight and unowned records are byte-preserved; repeat maintenance is a no-op",
    );
}

async function verifyFullHealthyQueue() {
    const broker = await Broker.start(
        path.join(artifacts, "full-healthy"),
        128 * 1024,
    );
    await broker.manager.streams.add({
        name: stream,
        subjects: [resolveNatsJobStreamSubjectFilter(prefix)],
        retention: RetentionPolicy.Workqueue,
        storage: StorageType.File,
        max_age: NATS_JOB_STREAM_MAX_AGE_NANOS,
    });
    await broker.manager.consumers.add(stream, {
        durable_name: "healthy",
        filter_subject: subject("healthy"),
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
    });
    let limited = false;
    for (let i = 0; i < 100; i++) {
        try {
            await broker.client.publish(
                subject("healthy"),
                new Uint8Array(8 * 1024),
            );
        } catch {
            limited = true;
            break;
        }
    }
    assert(limited, "Fixture must reach a real resource limit");
    const before = (await broker.manager.streams.info(stream)).state.messages;
    await assert.rejects(() => maintain(broker), /queued work was preserved/);
    assert.equal(
        (await broker.manager.streams.info(stream)).state.messages,
        before,
    );
    assert.equal(
        (await broker.manager.consumers.info(stream, "healthy")).num_pending,
        before,
    );
    await broker.stop();
    results.push(
        "storage-full healthy pending queue fails recovery without deleting work",
    );
}

async function prepare(store: string, port = 0) {
    const targetPort = port || (await freePort());
    try {
        // Assert the native child CLI contract at the executable boundary.
        await exec(
            nativeBinary,
            [
                "--prepare-nats-job-store",
                store,
                prefix,
                `127.0.0.1:${targetPort}`,
            ],
            { cwd: root, env: environment, timeout: 10_000 },
        );
    } catch (error) {
        const detail = error as Error & { stderr?: string };
        throw new Error(`${detail.message}\n${detail.stderr ?? ""}`);
    }
}

async function maintain(broker: Broker) {
    const adapter = await NatsJobStreamMaintenanceAdapter.connect({
        natsUrl: broker.url,
        streamPrefix: prefix,
    });
    try {
        return await new MaintainNatsJobStream(adapter, {
            report: () => {},
        }).execute();
    } finally {
        await adapter.close();
    }
}

async function freePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
    return port;
}

class Broker {
    readonly url: string;
    readonly client;
    private stopped = false;
    private constructor(
        readonly store: string,
        readonly port: number,
        private child: ChildProcess,
        private connection: NatsConnection,
        readonly manager: Awaited<
            ReturnType<NatsConnection["jetstreamManager"]>
        >,
    ) {
        this.url = `nats://127.0.0.1:${port}`;
        this.client = connection.jetstream({ timeout: 3_000 });
        active.add(this);
    }
    static async start(store: string, maxBytes = 64 * 1024 * 1024) {
        await mkdir(store, { recursive: true });
        const port = await freePort();
        const run = await mkdtemp(path.join(artifacts, "broker-"));
        const config = path.join(run, "server.conf");
        await writeFile(
            config,
            `host: "127.0.0.1"\nport: ${port}\njetstream { store_dir: ${JSON.stringify(store)}, max_file_store: ${maxBytes} }\n`,
        );
        const log = await open(path.join(run, "server.log"), "w");
        const child = spawn(natsBinary, ["-c", config], {
            cwd: root,
            stdio: ["ignore", log.fd, log.fd],
        });
        await log.close();
        let connection: NatsConnection | undefined;
        try {
            const deadline = Date.now() + 10_000;
            while (Date.now() < deadline && child.exitCode === null) {
                try {
                    connection = await connect({
                        servers: `nats://127.0.0.1:${port}`,
                        reconnect: false,
                        timeout: 300,
                    });
                    const manager = await connection.jetstreamManager({
                        timeout: 1_000,
                    });
                    return new Broker(store, port, child, connection, manager);
                } catch {
                    await connection?.close();
                    connection = undefined;
                    await delay(50);
                }
            }
            throw new Error(
                `Synthetic NATS failed to start; see ${path.relative(root, run)}`,
            );
        } catch (error) {
            await stopChild(child);
            throw error;
        }
    }
    async stop() {
        if (this.stopped) return;
        this.stopped = true;
        await this.connection.close();
        await stopChild(this.child);
        active.delete(this);
    }
}

async function messageDiskUsage(directory: string) {
    let bytes = 0;
    let allocatedBytes = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".blk")) {
            const info = await stat(path.join(directory, entry.name));
            bytes += info.size;
            allocatedBytes += (info.blocks ?? 0) * 512;
        }
    }
    return { bytes, allocatedBytes };
}

async function stopChild(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve, reject) => {
        child.once("exit", () => resolve());
        child.once("error", reject);
    });
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    try {
        await exited;
    } finally {
        clearTimeout(timer);
    }
}

try {
    await verifyOfflineAgeMigration();
    await verifySelectiveCleanup();
    await verifyFullHealthyQueue();
    await writeFile(
        path.join(artifacts, "results.json"),
        JSON.stringify(
            { natsVersion: DEFAULT_DESKTOP_NATS_VERSION, results },
            null,
            2,
        ) + "\n",
    );
    console.log(
        `Passed ${results.length} NATS recovery scenarios. Artifacts: ${path.relative(root, artifacts)}`,
    );
} finally {
    for (const broker of active) await broker.stop();
}
