#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { build } from "esbuild";
import { localDesktopPaths, projectRoot } from "./local-desktop-contract.mjs";
import { localRuntimeBuildOptions } from "./local-desktop-runtime-options.mjs";
import { assertLocalRuntimeProfiles } from "./local-desktop-dependencies.mjs";
import { verifyLocalDesktopObservabilityDependencies } from "./verify-local-desktop-observability.mjs";

const resources = process.argv[2]
    ? path.resolve(process.argv[2])
    : localDesktopPaths().resources;
await assertLocalRuntimeProfiles(resources);
const nodeBinaryPath = path.join(
    resources,
    "node",
    process.platform === "win32" ? "node.exe" : "node",
);
await verifyLocalDesktopObservabilityDependencies({
    resourcesRootDir: resources,
    nodeBinaryPath,
});
await mkdir(path.join(projectRoot, "tmp"), { recursive: true });
const fixture = await mkdtemp(
    path.join(projectRoot, "tmp", "local-exporter-test-"),
);
await cp(
    path.join(resources, "backend", "node_modules"),
    path.join(fixture, "node_modules"),
    { recursive: true },
);
await build({
    ...localRuntimeBuildOptions(projectRoot),
    entryPoints: {
        probe: path.join(
            projectRoot,
            "scripts/build/local-desktop-observability-probe.ts",
        ),
    },
    outdir: fixture,
});

const received = [];
const collector = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push({
        path: request.url,
        bytes: Buffer.concat(chunks).length,
        type: request.headers["content-type"],
    });
    response.setHeader("Content-Type", "application/json");
    response.end("{}");
});
await listen(collector);
const collectorUrl = `http://127.0.0.1:${collector.address().port}`;
const reservation = createServer();
await listen(reservation);
const metricsPort = reservation.address().port;
await close(reservation);
try {
    // New child per run matches the native supervisor's stop/restart lifecycle.
    for (const enabled of [false, true, true]) {
        received.length = 0;
        await runProbe(enabled);
        if (enabled) {
            assert.ok(
                received.some(
                    (entry) => entry.path === "/v1/traces" && entry.bytes > 0,
                ),
                "existing OTLP exporter must deliver spans",
            );
            assert.ok(
                received.some(
                    (entry) =>
                        entry.path.startsWith("/ingest") && entry.bytes > 0,
                ),
                "existing Pyroscope exporter must deliver profiles",
            );
        } else {
            assert.deepEqual(received, [], "disabled settings must not export");
        }
        console.log(
            `Local desktop exporter smoke passed (enabled=${enabled}):`,
            received,
        );
    }
} finally {
    await close(collector);
}

function runProbe(enabled) {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    return new Promise((resolve, reject) => {
        const child = spawn(
            nodeBinaryPath,
            [
                path.join(fixture, "probe.mjs"),
                collectorUrl,
                String(metricsPort),
                String(enabled),
            ],
            {
                cwd: fixture,
                env,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        let output = "";
        const timeout = setTimeout(() => child.kill("SIGKILL"), 45_000);
        child.stdout.on("data", (chunk) => {
            output += chunk;
            process.stdout.write(chunk);
        });
        child.stderr.on("data", (chunk) => {
            output += chunk;
            process.stderr.write(chunk);
        });
        child.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once("exit", (code, signal) => {
            clearTimeout(timeout);
            if (
                code !== 0 ||
                /Tracing disabled|Profiling disabled|APM enabled but no runtime|Metrics disabled/.test(
                    output,
                )
            ) {
                reject(
                    new Error(
                        `Local exporter probe failed (${code ?? signal}).`,
                    ),
                );
            } else resolve();
        });
    });
}
function listen(server) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
}
function close(server) {
    return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
}
