#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import { ensureGrafanaProvisioningPermissions } from "./ensure-grafana-provisioning-permissions.mjs";

const DOCKER_COMMAND = "docker";
const OBSERVABILITY_COMPOSE_PROFILE = "observability";

// Keep local observability shortcuts scoped to these compose services only.
const OBSERVABILITY_SERVICE_NAMES = [
    "loki",
    "tempo",
    "pyroscope",
    "alloy",
    "prometheus",
    "grafana",
];

// User-facing modes supported by the root package observability shortcuts.
const OBSERVABILITY_COMPOSE_MODES = Object.freeze({
    up: "up",
    stop: "stop",
    down: "down",
});

const requestedMode = process.argv[2];

if (!isKnownMode(requestedMode)) {
    console.error(
        `Usage: node scripts/observability/compose.mjs ${Object.values(
            OBSERVABILITY_COMPOSE_MODES,
        ).join("|")}`,
    );
    process.exit(1);
}

if (requestedMode === OBSERVABILITY_COMPOSE_MODES.up) {
    await ensureGrafanaProvisioningPermissions();
}

runDockerCompose(buildComposeArgs(requestedMode));

function isKnownMode(value) {
    return Object.values(OBSERVABILITY_COMPOSE_MODES).includes(value);
}

function buildComposeArgs(mode) {
    const baseArgs = ["compose", "--profile", OBSERVABILITY_COMPOSE_PROFILE];

    switch (mode) {
        case OBSERVABILITY_COMPOSE_MODES.up:
            return [...baseArgs, "up", "-d", ...OBSERVABILITY_SERVICE_NAMES];
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
    }
}

function runDockerCompose(args) {
    const result = spawnSync(DOCKER_COMMAND, args, { stdio: "inherit" });

    if (result.error !== undefined) {
        throw result.error;
    }

    if (result.signal !== null) {
        console.error(`Docker compose exited after signal ${result.signal}.`);
        process.exit(1);
    }

    process.exit(result.status ?? 1);
}
