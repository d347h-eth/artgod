#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureGrafanaProvisioningPermissions } from "./ensure-grafana-provisioning-permissions.mjs";
import {
    loadObservabilityConfig,
    observabilityComposeEnvironment,
    OBSERVABILITY_PORTS,
    parseObservabilityArgs,
    prepareObservabilityInputs,
} from "./local-config.mjs";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));

// NATS and natsbox belong to the app infrastructure, not this collector project.
export const OBSERVABILITY_SERVICE_NAMES = Object.freeze([
    "loki",
    "tempo",
    "pyroscope",
    "alloy",
    "prometheus",
    "grafana",
]);

// User-facing modes supported by the root package observability shortcuts.
export const OBSERVABILITY_COMPOSE_MODES = Object.freeze({
    up: "up",
    stop: "stop",
    down: "down",
    config: "config",
});

export function buildComposeArgs(mode, config) {
    const baseArgs = [
        "compose",
        "--project-name",
        config.projectName,
        "--project-directory",
        config.rootDir,
        "--file",
        path.join(config.rootDir, "docker-compose.yml"),
        "--profile",
        "observability",
    ];

    switch (mode) {
        case OBSERVABILITY_COMPOSE_MODES.up:
            return [
                ...baseArgs,
                "up",
                "-d",
                ...(config.pull ? ["--pull", config.pull] : []),
                ...OBSERVABILITY_SERVICE_NAMES,
            ];
        case OBSERVABILITY_COMPOSE_MODES.stop:
            return [...baseArgs, "stop", ...OBSERVABILITY_SERVICE_NAMES];
        case OBSERVABILITY_COMPOSE_MODES.down:
            return [
                ...baseArgs,
                "rm",
                "--stop",
                "--force",
                ...OBSERVABILITY_SERVICE_NAMES,
            ];
        case OBSERVABILITY_COMPOSE_MODES.config:
            return [...baseArgs, "config", "--format", "json"];
        default:
            throw new Error(
                `Unknown observability command: ${mode ?? "(missing)"}. Use up, stop, down, or config.`,
            );
    }
}

async function main() {
    const [mode, ...args] = process.argv.slice(2);
    const options = parseObservabilityArgs(args);
    if (options.help || mode === "--help" || mode === "-h") {
        console.log(`Usage: yarn observability:up [options]
       yarn observability:stop|observability:down|observability:config [options]

  --port NAME=PORT           Repeat to remap ${Object.keys(OBSERVABILITY_PORTS).join(", ")}
  --metrics-port NAME=PORT   Repeat to match a runtime's metrics port (e.g. bidding-bot=42754)
  --logs-dir PATH            Existing app log directory (default: tmp/logs)
  --project-name NAME        Compose project (default: artgod-observability)
  --env-file PATH            Local defaults (default: .env.observability, if present)
  --pull always|missing|never  Image pull policy for up

CLI options override shell environment, then the local env file, then defaults.
Relative paths resolve from this checkout. See .env.observability.example.`);
        return;
    }
    if (!Object.values(OBSERVABILITY_COMPOSE_MODES).includes(mode)) {
        throw new Error(
            "Use yarn observability:up, observability:stop, observability:down, or observability:config. Add --help for options.",
        );
    }
    if (options.pull !== undefined && mode !== OBSERVABILITY_COMPOSE_MODES.up) {
        throw new Error("--pull is supported only by observability:up.");
    }
    const config = await loadObservabilityConfig(options, rootDir);
    if (
        mode === OBSERVABILITY_COMPOSE_MODES.up ||
        mode === OBSERVABILITY_COMPOSE_MODES.config
    ) {
        await prepareObservabilityInputs(config);
    }
    if (mode === OBSERVABILITY_COMPOSE_MODES.up) {
        await ensureGrafanaProvisioningPermissions();
        console.log(
            `Observability project: ${config.projectName}\nLogs: ${config.logsDir}`,
        );
    }

    const result = spawnSync("docker", buildComposeArgs(mode, config), {
        cwd: rootDir,
        env: observabilityComposeEnvironment(config),
        stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.signal)
        throw new Error(`Docker Compose exited after signal ${result.signal}.`);
    process.exitCode = result.status ?? 1;
    if (process.exitCode === 0 && mode === OBSERVABILITY_COMPOSE_MODES.up) {
        console.log(`Grafana: http://127.0.0.1:${config.ports.grafana} (admin / admin on a fresh volume)
Prometheus: http://127.0.0.1:${config.ports.prometheus}
Loki: http://127.0.0.1:${config.ports.loki}
Tempo: http://127.0.0.1:${config.ports.tempo}
App trace exporter URL: http://127.0.0.1:${config.ports.otlp}/v1/traces
App profile exporter URL: http://127.0.0.1:${config.ports.pyroscope}`);
    }
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
