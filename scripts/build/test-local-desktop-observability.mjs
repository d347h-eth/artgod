#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { build } from "esbuild";
import { localDesktopPaths, projectRoot } from "./local-desktop-contract.mjs";
import { localRuntimeBuildOptions } from "./local-desktop-runtime-options.mjs";
import { assertLocalRuntimeProfiles } from "./local-desktop-dependencies.mjs";
import { verifyLocalDesktopObservabilityDependencies } from "./verify-local-desktop-observability.mjs";
import {
    parseManifest,
    resolveDefaultForTarget,
} from "../config/generate-env-example.mjs";
import { createLocalDesktopProbe } from "./local-desktop-observability-probe-contract.mjs";
import { verifyComposeSignals } from "./local-desktop-observability-signals.mjs";

const args = process.argv.slice(2);
const useCompose = args[0] === "--compose";
if (useCompose) args.shift();
if (args.length > 1 || args.some((arg) => arg.startsWith("--")))
    throw new Error(
        "Usage: test-local-desktop-observability.mjs [--compose] [runtime-directory]",
    );
const compose = useCompose ? await readComposeEndpoints() : null;
const resources = args[0]
    ? path.resolve(args[0])
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
    const entry = {
        path: request.url,
        bytes: Buffer.concat(chunks).length,
        type: request.headers["content-type"],
    };
    received.push(entry);
    if (compose) {
        try {
            const target = new URL(
                request.url,
                request.url.startsWith("/v1/traces")
                    ? compose.otlp
                    : compose.pyroscope,
            );
            // Forward only probe payload metadata needed by the existing exporters.
            const headers = Object.fromEntries(
                ["content-type", "content-encoding"].flatMap((key) =>
                    request.headers[key] ? [[key, request.headers[key]]] : [],
                ),
            );
            const forwarded = await fetch(target, {
                method: request.method,
                headers,
                body: Buffer.concat(chunks),
                signal: AbortSignal.timeout(10_000),
            });
            entry.status = forwarded.status;
            response.writeHead(forwarded.status);
            response.end(await forwarded.text());
        } catch {
            entry.status = 502;
            response.writeHead(502);
            response.end("Probe collector forwarding failed");
        }
    } else {
        response.setHeader("Content-Type", "application/json");
        response.end("{}");
    }
});
await listen(collector);
const collectorUrl = `http://127.0.0.1:${collector.address().port}`;
const reservation = createServer();
await listen(reservation, compose?.metricsPort ?? 0);
const metricsPort = reservation.address().port;
await close(reservation);
try {
    // New child per run matches the native supervisor's stop/restart lifecycle.
    for (const enabled of [false, true, true]) {
        const probe = createLocalDesktopProbe();
        const startedAt = Date.now();
        received.length = 0;
        await runProbe(enabled, probe);
        if (enabled) {
            assert.ok(
                received.some(
                    (entry) => entry.path === "/v1/traces" && entry.bytes > 0,
                ),
                "existing OTLP exporter must deliver spans",
            );
            if (compose) {
                assert.ok(
                    received.every(
                        (entry) => entry.status >= 200 && entry.status < 300,
                    ),
                    "Compose must accept every exporter payload",
                );
                await verifyComposeSignals(compose, probe, startedAt);
            }
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

function runProbe(enabled, probe) {
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
                probe.runId,
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
function listen(server, port = 0) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    });
}

async function readComposeEndpoints() {
    const manifest = parseManifest(
        await readFile(
            new URL("../../config/settings.manifest.toml", import.meta.url),
            "utf8",
        ),
    );
    const settingDefault = (key) => {
        const setting = manifest.settings.find((entry) => entry.key === key);
        if (!setting) throw new Error(`Missing Compose probe setting: ${key}`);
        return resolveDefaultForTarget(setting, "local");
    };
    const datasourceUrl = async (name) => {
        const source = await readFile(
            new URL(
                `../../observability/grafana/provisioning/datasources/${name}.yaml`,
                import.meta.url,
            ),
            "utf8",
        );
        const urls = [...source.matchAll(/^\s+url:\s+(http\S+)\s*$/gm)];
        if (urls.length !== 1)
            throw new Error(
                `Expected one ${name} datasource URL in the repository Compose config`,
            );
        return urls[0][1];
    };
    const endpoints = {
        otlp: settingDefault("OBSERVABILITY_OTLP_HTTP_URL"),
        pyroscope: settingDefault("OBSERVABILITY_PYROSCOPE_URL"),
        metricsPort: Number(settingDefault("BACKEND_METRICS_PORT")),
        prometheus: await datasourceUrl("prometheus"),
        tempo: await datasourceUrl("tempo"),
    };
    for (const key of ["otlp", "pyroscope", "prometheus", "tempo"]) {
        const url = new URL(endpoints[key]);
        if (
            url.protocol !== "http:" ||
            url.hostname !== "127.0.0.1" ||
            url.username ||
            url.password
        )
            throw new Error(
                `Compose probe requires a numeric loopback ${key} endpoint`,
            );
    }
    if (
        !Number.isInteger(endpoints.metricsPort) ||
        endpoints.metricsPort < 1 ||
        endpoints.metricsPort > 65535
    )
        throw new Error(
            "Compose probe requires a valid backend metrics TCP port",
        );
    return endpoints;
}

function close(server) {
    return new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
    );
}
