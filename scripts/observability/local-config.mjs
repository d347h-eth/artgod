import {
    access,
    mkdir,
    readFile,
    realpath,
    stat,
    writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs, parseEnv } from "node:util";

// Local collector settings are separate from desktop/deploy application settings.
export const OBSERVABILITY_ENV = Object.freeze({
    projectName: "ARTGOD_OBSERVABILITY_PROJECT_NAME",
    logsDir: "ARTGOD_OBSERVABILITY_LOGS_DIR",
    metricsPorts: "ARTGOD_OBSERVABILITY_METRICS_PORTS",
    targetsFile: "ARTGOD_OBSERVABILITY_TARGETS_FILE",
});

export const OBSERVABILITY_PORTS = Object.freeze({
    loki: { port: 42730, env: "ARTGOD_OBSERVABILITY_LOKI_PORT" },
    tempo: { port: 42731, env: "ARTGOD_OBSERVABILITY_TEMPO_PORT" },
    otlp: { port: 42732, env: "ARTGOD_OBSERVABILITY_OTLP_PORT" },
    pyroscope: { port: 42733, env: "ARTGOD_OBSERVABILITY_PYROSCOPE_PORT" },
    prometheus: { port: 42734, env: "ARTGOD_OBSERVABILITY_PROMETHEUS_PORT" },
    grafana: { port: 42735, env: "ARTGOD_OBSERVABILITY_GRAFANA_PORT" },
});

export const DEFAULT_OBSERVABILITY_PROJECT = "artgod-observability";
export const LOCAL_ENV_FILE = ".env.observability";

/** @typedef {{ targets: string[], labels: {job: string, runtime: string} }} TargetGroup */
/**
 * @typedef {object} ObservabilityConfig
 * @property {string} rootDir
 * @property {string} projectName
 * @property {string} logsDir
 * @property {Record<string, number>} ports
 * @property {TargetGroup[]} targets
 * @property {string} targetsFile
 * @property {string | undefined} pull
 */

export function parseObservabilityArgs(args) {
    return parseArgs({
        args,
        options: {
            port: { type: "string", multiple: true },
            "metrics-port": { type: "string", multiple: true },
            "logs-dir": { type: "string" },
            "project-name": { type: "string" },
            "env-file": { type: "string" },
            pull: { type: "string" },
            help: { type: "boolean", short: "h" },
        },
    }).values;
}

/** Resolve CLI > shell environment > local env file > repository defaults. */
export async function loadObservabilityConfig(
    options,
    rootDir,
    environment = process.env,
) {
    const envPath = resolveLocalPath(
        rootDir,
        options["env-file"] ?? LOCAL_ENV_FILE,
    );
    let fileEnvironment = {};
    try {
        fileEnvironment = parseEnv(await readFile(envPath, "utf8"));
    } catch (error) {
        if (error.code !== "ENOENT" || options["env-file"] !== undefined) {
            throw new Error(
                `Cannot read observability env file ${envPath}: ${error.message}`,
            );
        }
    }
    const knownKeys = new Set([
        OBSERVABILITY_ENV.projectName,
        OBSERVABILITY_ENV.logsDir,
        OBSERVABILITY_ENV.metricsPorts,
        ...Object.values(OBSERVABILITY_PORTS).map(({ env }) => env),
    ]);
    for (const key of Object.keys(fileEnvironment)) {
        if (!knownKeys.has(key)) {
            throw new Error(
                `Unknown setting ${key} in ${envPath}. See ${LOCAL_ENV_FILE}.example.`,
            );
        }
    }
    const env = { ...fileEnvironment, ...environment };
    const projectName =
        options["project-name"] ??
        env[OBSERVABILITY_ENV.projectName] ??
        DEFAULT_OBSERVABILITY_PROJECT;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(projectName)) {
        throw new Error(
            "Project name must start with a lowercase letter or digit and contain only lowercase letters, digits, '-' or '_'.",
        );
    }
    const ports = Object.fromEntries(
        Object.entries(OBSERVABILITY_PORTS).map(([name, definition]) => [
            name,
            env[definition.env] ?? String(definition.port),
        ]),
    );
    applyPortOverrides(options.port ?? [], ports, "--port");

    /** @type {TargetGroup[]} */
    const targets = JSON.parse(
        await readFile(
            path.join(rootDir, "observability/prometheus/targets.json"),
            "utf8",
        ),
    );
    const metricsPorts = Object.fromEntries(
        targets.map((group) => [
            group.labels.runtime,
            group.targets[0].split(":")[1],
        ]),
    );
    applyPortOverrides(
        [
            ...(env[OBSERVABILITY_ENV.metricsPorts]
                ? env[OBSERVABILITY_ENV.metricsPorts].split(",")
                : []),
            ...(options["metrics-port"] ?? []),
        ],
        metricsPorts,
        "--metrics-port",
    );
    for (const group of targets) {
        group.targets = [`127.0.0.1:${metricsPorts[group.labels.runtime]}`];
    }

    // All collectors and scraped runtimes share this host's loopback namespace.
    const usedPorts = new Map();
    for (const [name, port] of [
        ...Object.entries(ports),
        ...Object.entries(metricsPorts),
    ]) {
        if (usedPorts.has(port)) {
            throw new Error(
                `TCP port ${port} is assigned to both ${usedPorts.get(port)} and ${name}. Choose different ports.`,
            );
        }
        usedPorts.set(port, name);
    }
    if (
        options.pull !== undefined &&
        !["always", "missing", "never"].includes(options.pull)
    ) {
        throw new Error("--pull must be always, missing, or never.");
    }
    const logsDir =
        options["logs-dir"] ?? env[OBSERVABILITY_ENV.logsDir] ?? "tmp/logs";
    if (logsDir.trim() === "") {
        throw new Error(
            "Logs directory must not be empty. Set --logs-dir to the app's existing log directory.",
        );
    }
    /** @type {ObservabilityConfig} */
    const config = {
        rootDir,
        projectName,
        logsDir: resolveLocalPath(rootDir, logsDir),
        ports,
        targets,
        targetsFile: path.join(
            rootDir,
            "tmp/observability",
            projectName,
            "targets.json",
        ),
        pull: options.pull,
    };
    return config;
}

/** Prepare local inputs; never create a missing external app log directory. */
export async function prepareObservabilityInputs(config) {
    if (config.logsDir === path.join(config.rootDir, "tmp/logs")) {
        await mkdir(config.logsDir, { recursive: true });
    }
    try {
        if (!(await stat(config.logsDir)).isDirectory()) {
            throw new Error("path is not a directory");
        }
        await access(config.logsDir, constants.R_OK | constants.X_OK);
        config.logsDir = await realpath(config.logsDir);
    } catch (error) {
        throw new Error(
            `Cannot read logs directory ${config.logsDir}: ${error.message}. Set --logs-dir to the app's existing log directory.`,
        );
    }
    await mkdir(path.dirname(config.targetsFile), { recursive: true });
    // Keep the inode stable for Docker's file bind mount and file discovery.
    await writeFile(
        config.targetsFile,
        `${JSON.stringify(config.targets, null, 4)}\n`,
        { mode: 0o644 },
    );
}

export function observabilityComposeEnvironment(
    config,
    environment = process.env,
) {
    const env = {
        ...environment,
        // Explicit files/project plus this flag avoid unrelated checkout .env defaults.
        COMPOSE_DISABLE_ENV_FILE: "true",
        [OBSERVABILITY_ENV.logsDir]: config.logsDir,
        [OBSERVABILITY_ENV.targetsFile]: config.targetsFile,
    };
    delete env.COMPOSE_ENV_FILES;
    for (const [name, { env: key }] of Object.entries(OBSERVABILITY_PORTS)) {
        env[key] = String(config.ports[name]);
    }
    return env;
}

function parsePort(value, name) {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        throw new Error(
            `Invalid TCP port for ${name}: ${JSON.stringify(value)}. Use an integer from 1 to 65535.`,
        );
    }
    return Number(value);
}

function applyPortOverrides(assignments, ports, option) {
    for (const assignment of assignments) {
        const [name, value, extra] = assignment.split("=");
        if (
            !Object.hasOwn(ports, name) ||
            value === undefined ||
            extra !== undefined
        ) {
            throw new Error(
                `Invalid ${option} ${JSON.stringify(assignment)}. Use NAME=PORT; names: ${Object.keys(ports).join(", ")}.`,
            );
        }
        ports[name] = value;
    }
    // Validate effective values after precedence, so a CLI override can repair
    // an invalid lower-priority value for that same endpoint.
    for (const [name, value] of Object.entries(ports)) {
        ports[name] = parsePort(value, name);
    }
}

function resolveLocalPath(rootDir, value) {
    return path.resolve(
        rootDir,
        value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value,
    );
}
