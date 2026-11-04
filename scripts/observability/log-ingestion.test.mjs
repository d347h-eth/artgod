import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    appendFile,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { buildComposeArgs, OBSERVABILITY_COMPOSE_MODES } from "./compose.mjs";
import {
    loadObservabilityConfig,
    observabilityComposeEnvironment,
    OBSERVABILITY_PORTS,
    parseObservabilityArgs,
    prepareObservabilityInputs,
} from "./local-config.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const TEST_ACTION = "observability_log_test";

// Exercise the collector against the process names owned by Rust, rather than
// inventing filenames that already happen to match the collector's globs.
async function desktopLogFixtures(date) {
    const registry = await readFile(
        path.join(projectRoot, "src-tauri/src/runtime/process_registry.rs"),
        "utf8",
    );
    const names = new Map(
        [
            ...registry.matchAll(
                /\bconst\s+([A-Z_]*PROCESS_NAME):\s*&str\s*=\s*"([^"]+)"/g,
            ),
        ].map((match) => [match[1], match[2]]),
    );
    const backend = names.get("BACKEND_PROCESS_NAME");
    const supervisor = names.get("SUPERVISOR_PROCESS_NAME");
    const nats = names.get("NATS_PROCESS_NAME");
    assert.ok(
        backend && supervisor && nats,
        "Desktop process identities must be declared by the registry.",
    );
    const processes = [...names.values()].map((process) => {
        if (process === backend)
            return { process, runtime: "backend-api", component: "BackendApi" };
        if (process === supervisor)
            return {
                process,
                runtime: process,
                component: "DesktopSupervisor",
            };
        if (process === nats)
            return { process, runtime: nats, component: process };
        assert.ok(
            process.startsWith("indexer-"),
            `Classify the new desktop process ${process} in log coverage.`,
        );
        return { process, runtime: "indexer", component: process };
    });
    const workers = registry.match(/INDEXER_WORKERS[^=]*=\s*&\[([\s\S]*?)\];/);
    assert.ok(workers, "Desktop worker registry must exist.");
    for (const [, process] of workers[1].matchAll(/\(\s*"([^"]+)"/g)) {
        processes.push({ process, runtime: "indexer", component: process });
    }
    const desktop = await readFile(
        path.join(projectRoot, "src-tauri/src/desktop_log.rs"),
        "utf8",
    );
    const app = desktop.match(
        /const DESKTOP_APP_PROCESS_NAME:\s*&str\s*=\s*"([^"]+)"/,
    )?.[1];
    assert.ok(app, "Native app log identity must be declared.");
    processes.push({
        process: app,
        runtime: app,
        component: "DesktopLifecycle",
    });
    const natsStore = await readFile(
        path.join(projectRoot, "src-tauri/src/runtime/nats_store.rs"),
        "utf8",
    );
    const preparation = natsStore.match(
        /const PREPARE_STORE_PROCESS_NAME:\s*&str\s*=\s*"([^"]+)"/,
    )?.[1];
    assert.ok(preparation, "NATS preparation log identity must be declared.");
    processes.push({
        process: preparation,
        runtime: nats,
        component: preparation,
    });
    const bots = await readFile(
        path.join(projectRoot, "src-tauri/src/runtime/bot_runtime.rs"),
        "utf8",
    );
    const botNames = [...bots.matchAll(/process_name:\s*"([^"]+)"/g)];
    assert.ok(botNames.length, "Desktop bot log identities must be declared.");
    for (const [, process] of botNames) {
        processes.push({ process, runtime: "trading-bot", component: process });
    }
    const files = processes.flatMap((entry) => [
        { ...entry, filename: `${entry.process}.log` },
        { ...entry, filename: `${entry.process}-${date}.log` },
    ]);
    for (const [script, runtime] of [
        ["backend-dev.sh", "backend-api"],
        ["frontend-dev.sh", "frontend-web"],
    ]) {
        const source = await readFile(
            path.join(projectRoot, "scripts", script),
            "utf8",
        );
        const filename = source.match(
            /LOG_FILE="\$LOG_DIR\/([^"]+\.log)"/,
        )?.[1];
        assert.ok(
            filename,
            `Standalone log filename must be declared in ${script}.`,
        );
        files.push({ filename, runtime, component: runtime });
    }
    assert.equal(
        new Set(files.map(({ filename }) => filename)).size,
        files.length,
    );
    return files;
}

async function freePort(excluded) {
    for (;;) {
        const server = createServer();
        await new Promise((resolve, reject) =>
            server.once("error", reject).listen(0, "127.0.0.1", resolve),
        );
        const port = server.address().port;
        await new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
        if (!excluded.has(port)) return port;
    }
}

async function eventually(label, check) {
    const deadline = Date.now() + 45000;
    let last;
    do {
        try {
            const result = await check();
            if (result) return result;
        } catch (error) {
            last = error;
        }
        await setTimeout(500);
    } while (Date.now() < deadline);
    throw new Error(`${label}: ${last?.message ?? "condition not met"}`);
}

function metricSum(source, name) {
    return source
        .split("\n")
        .filter(
            (line) =>
                line.startsWith(`${name}{`) || line.startsWith(`${name} `),
        )
        .reduce(
            (sum, line) => sum + Number(line.trim().split(/\s+/).at(-1)),
            0,
        );
}

test(
    "Alloy tails desktop/launcher files, skips existing contents, and resumes saved positions",
    { timeout: 180000 },
    async () => {
        await mkdir(path.join(projectRoot, "tmp"), { recursive: true });
        const root = await mkdtemp(
            path.join(projectRoot, "tmp/observability-log-test-"),
        );
        for (const relative of [
            "docker-compose.yml",
            "observability/alloy/config.alloy",
            "observability/loki/loki-config.yaml",
            "observability/prometheus/targets.json",
        ]) {
            const target = path.join(root, relative);
            await mkdir(path.dirname(target), { recursive: true });
            await copyFile(path.join(projectRoot, relative), target);
        }
        const defaults = JSON.parse(
            await readFile(
                path.join(root, "observability/prometheus/targets.json"),
                "utf8",
            ),
        );
        const reserved = new Set([
            ...Object.values(OBSERVABILITY_PORTS).map(({ port }) => port),
            ...defaults.map(({ targets }) => Number(targets[0].split(":")[1])),
        ]);
        const lokiPort = await freePort(reserved);
        reserved.add(lokiPort);
        const alloyPort = await freePort(reserved);
        const config = await loadObservabilityConfig(
            parseObservabilityArgs([
                "--project-name",
                `artgod-log-test-${process.pid}`,
                "--logs-dir",
                "app logs $literal",
                "--port",
                `loki=${lokiPort}`,
            ]),
            root,
            {},
        );
        await mkdir(config.logsDir, { recursive: true, mode: 0o755 });
        await prepareObservabilityInputs(config);
        const overlay = path.join(root, "diagnostics.json");
        await writeFile(
            overlay,
            JSON.stringify({
                services: {
                    alloy: { ports: [`127.0.0.1:${alloyPort}:42736`] },
                },
            }),
        );
        const up = buildComposeArgs(OBSERVABILITY_COMPOSE_MODES.up, config);
        const base = [
            ...up.slice(0, up.indexOf(OBSERVABILITY_COMPOSE_MODES.up)),
            "--file",
            overlay,
        ];
        const env = observabilityComposeEnvironment(config);
        function compose(args) {
            const result = spawnSync("docker", [...base, ...args], {
                env,
                encoding: "utf8",
                timeout: 45000,
            });
            assert.ifError(result.error);
            assert.equal(
                result.status,
                0,
                `${args.join(" ")}: ${result.stderr}`,
            );
            return result.stdout;
        }
        const runId = path.basename(root);
        const timestamp = new Date(Date.now() - 60000).toISOString();
        const files = await desktopLogFixtures(timestamp.slice(0, 10));
        const phases = new Map(
            files.map(({ filename }) => [filename, new Set()]),
        );
        const byteOffsets = new Map();
        const record = (file, phase) =>
            `${JSON.stringify({
                t: timestamp,
                level: "info",
                component: file.component,
                action: TEST_ACTION,
                msg: `${runId}:${file.filename}:${phase}`,
                diagnostic: { runId, phase },
            })}\n`;
        async function append(file, phase, expectCollected = true) {
            const line = record(file, phase);
            await appendFile(path.join(config.logsDir, file.filename), line, {
                mode: 0o644,
            });
            if (expectCollected) phases.get(file.filename).add(phase);
            const bytes = Buffer.byteLength(line);
            byteOffsets.set(
                file.filename,
                (byteOffsets.get(file.filename) ?? 0) + bytes,
            );
            return bytes;
        }
        const query = `{app="artgod",action="${TEST_ACTION}"} |= "${runId}"`;
        const queryUrl = new URL(
            `http://127.0.0.1:${lokiPort}/loki/api/v1/query_range`,
        );
        queryUrl.search = new URLSearchParams({
            query,
            start: String((BigInt(Date.now()) - 3600000n) * 1000000n),
            limit: "1000",
        });
        async function assertCollected() {
            const response = await fetch(queryUrl, {
                signal: AbortSignal.timeout(4000),
            });
            const body = await response.text();
            assert.equal(response.status, 200, body);
            const data = JSON.parse(body);
            const observed = new Map();
            for (const stream of data.data.result) {
                const filename = path.basename(stream.stream.filename);
                const file = files.find((entry) => entry.filename === filename);
                assert.ok(file, `Unexpected stream ${filename}`);
                assert.equal(stream.stream.runtime, file.runtime);
                assert.equal(stream.stream.component, file.component);
                assert.ok(!Object.hasOwn(stream.stream, "diagnostic"));
                for (const [time, line] of stream.values) {
                    const entry = JSON.parse(line);
                    assert.equal(entry.diagnostic.runId, runId);
                    assert.ok(
                        !entry.diagnostic.phase.startsWith("before-"),
                        `Existing contents must be skipped: ${filename}:${entry.diagnostic.phase}`,
                    );
                    assert.equal(
                        BigInt(time) / 1000000n,
                        BigInt(Date.parse(timestamp)),
                    );
                    const seen = observed.get(filename) ?? new Set();
                    seen.add(entry.diagnostic.phase);
                    observed.set(filename, seen);
                }
            }
            const missing = [...phases]
                .filter(([filename, expected]) =>
                    [...expected].some(
                        (phase) => !observed.get(filename)?.has(phase),
                    ),
                )
                .map(([filename]) => filename);
            assert.deepEqual(
                missing,
                [],
                `Missing logs: ${missing.join(", ")}`,
            );
            return true;
        }
        const metrics = async () => {
            const response = await fetch(
                `http://127.0.0.1:${alloyPort}/metrics`,
                { signal: AbortSignal.timeout(4000) },
            );
            assert.equal(response.status, 200);
            return response.text();
        };
        // Observe actual checkpoints rather than racing their periodic timer.
        const checkpointed = () => {
            const source = compose([
                "exec",
                "-T",
                "alloy",
                "find",
                "/var/lib/alloy/data",
                "-name",
                "positions.yml",
                "-exec",
                "cat",
                "{}",
                "+",
            ]);
            const saved = new Map(
                [
                    ...source.matchAll(
                        /\?\s+path: ([^\n]+)\n\s+labels:[^\n]*\n\s+: "(\d+)"/g,
                    ),
                ].map((match) => [path.basename(match[1]), Number(match[2])]),
            );
            return files.every(
                ({ filename }) =>
                    saved.get(filename) === byteOffsets.get(filename),
            );
        };
        try {
            // Existing contents must not be imported when a file is first found.
            for (const file of files) await append(file, "before-start", false);
            compose([
                "run",
                "--rm",
                "--no-deps",
                "-T",
                "--pull",
                "never",
                "alloy",
                "validate",
                "/etc/alloy/config.alloy",
            ]);
            compose(["up", "-d", "--pull", "never", "loki", "alloy"]);
            await eventually(
                "Every reader must start after the pre-existing contents",
                async () =>
                    metricSum(
                        await metrics(),
                        "loki_source_file_files_active_total",
                    ) === files.length,
            );
            for (const file of files) await append(file, "after-start");
            await eventually(
                "New output must reach Loki for every emitted filename",
                assertCollected,
            );
            assert.equal(
                metricSum(await metrics(), "loki_source_file_read_lines_total"),
                files.length,
                "Only records appended after discovery may be read.",
            );
            console.log(
                `Collected new output for ${files.length} filenames without importing their existing contents.`,
            );
            const app = files.find(
                (file) => file.component === "DesktopLifecycle",
            );
            const nextDate = new Date(Date.parse(timestamp) + 86400000)
                .toISOString()
                .slice(0, 10);
            const rotation = {
                ...app,
                filename: `${app.process}-${nextDate}.log`,
            };
            files.push(rotation);
            phases.set(rotation.filename, new Set());
            await append(rotation, "before-discovery", false);
            await eventually(
                "New rotation must start at the end",
                async () =>
                    metricSum(
                        await metrics(),
                        "loki_source_file_files_active_total",
                    ) === files.length,
            );
            await append(rotation, "after-discovery");
            await eventually(
                "Output appended after rotation discovery must reach Loki",
                assertCollected,
            );
            assert.equal(
                metricSum(await metrics(), "loki_source_file_read_lines_total"),
                files.length,
                "Rotation must skip records written before discovery.",
            );
            console.log(
                "New rotations skipped existing contents and collected subsequent output.",
            );
            await eventually(
                "Read offsets must be checkpointed to the volume",
                checkpointed,
            );
            compose(["stop", "alloy"]);
            // These files already have saved positions. Output written while
            // stopped proves resume uses those offsets, not the tail default.
            for (const file of files) await append(file, "while-stopped");
            compose(["up", "-d", "--pull", "never", "alloy"]);
            await eventually(
                "All readers must resume after restart",
                async () =>
                    metricSum(
                        await metrics(),
                        "loki_source_file_files_active_total",
                    ) === files.length,
            );
            await eventually(
                "Saved offsets must resume output written while stopped",
                assertCollected,
            );
            assert.equal(
                metricSum(await metrics(), "loki_source_file_read_lines_total"),
                files.length,
                "Restart must resume saved positions without rereading history.",
            );
            for (const file of files) await append(file, "after-restart");
            await eventually(
                "Resumed readers must collect new output",
                assertCollected,
            );
            assert.equal(
                // read_bytes_total is a gauge of the file offset, while the
                // line counter measures records read by this Alloy process.
                metricSum(await metrics(), "loki_source_file_read_lines_total"),
                files.length * 2,
            );
            console.log(
                "Restart resumed saved offsets and collected output written during and after the stop.",
            );
            await writeFile(
                path.join(root, "verification.json"),
                `${JSON.stringify({ files, checks: ["skip existing contents", "labels", "timestamps", "append", "rotation", "saved positions"] }, null, 4)}\n`,
            );
        } catch (error) {
            await writeFile(
                path.join(root, "container-logs.txt"),
                compose(["logs", "--no-color", "--tail", "100"]),
            );
            console.error(`Collector diagnostics: ${root}`);
            throw error;
        } finally {
            // Only this test's project is disposable. Leave its tmp/ evidence in place.
            compose(["down", "--volumes"]);
        }
    },
);
