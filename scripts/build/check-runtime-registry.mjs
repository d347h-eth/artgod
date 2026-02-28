#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

const BUILD_SCRIPT_PATH = path.join(
    rootDir,
    "scripts",
    "build",
    "build-runtime-artifacts.mjs",
);
const SUPERVISOR_PATH = path.join(
    rootDir,
    "src-tauri",
    "src",
    "runtime",
    "supervisor.rs",
);
const INDEXER_PACKAGE_JSON_PATH = path.join(rootDir, "indexer", "package.json");
const INDEXER_DEV_SCRIPT_PATH = path.join(rootDir, "scripts", "indexer-dev.sh");
const PROMETHEUS_CONFIG_PATH = path.join(
    rootDir,
    "observability",
    "prometheus",
    "prometheus.yml",
);
const INDEXER_CONFIG_PATH = path.join(
    rootDir,
    "indexer",
    "src",
    "config",
    "index.ts",
);
const ENV_EXAMPLE_PATH = path.join(rootDir, ".env.example");

function stableSorted(values) {
    return [...values].sort((a, b) => a.localeCompare(b));
}

function formatSet(values) {
    return stableSorted(values).join(", ");
}

function toMetricsRuntime(workerArtifactName) {
    return workerArtifactName;
}

function toMetricsConfigKey(workerArtifactName) {
    return workerArtifactName
        .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
        .replace(/-/g, "");
}

function toMetricsEnvVar(workerArtifactName) {
    return `METRICS_PORT_${workerArtifactName
        .replace(/-/g, "_")
        .toUpperCase()}`;
}

function assertNoUnknownEntries({ source, expected, actual, errors }) {
    for (const value of actual) {
        if (!expected.has(value)) {
            errors.push(
                `${source}: unknown entry \"${value}\" (expected only: ${formatSet(expected)})`,
            );
        }
    }
}

function assertNoMissingEntries({ source, expected, actual, errors }) {
    for (const value of expected) {
        if (!actual.has(value)) {
            errors.push(`${source}: missing required entry \"${value}\"`);
        }
    }
}

async function parseBuildArtifacts() {
    const source = await readFile(BUILD_SCRIPT_PATH, "utf8");
    const workers = new Set();
    const pattern =
        /"([a-z0-9-]+)"\s*:\s*path\.join\([\s\S]*?"indexer"[\s\S]*?"src"[\s\S]*?"runtime"[\s\S]*?"([a-z0-9-]+)\.ts"[\s\S]*?\)/g;

    for (const match of source.matchAll(pattern)) {
        const workerName = match[1];
        if (workerName.endsWith("-worker")) {
            workers.add(workerName);
        }
    }

    if (workers.size === 0) {
        throw new Error(
            "Failed to parse indexer worker entryPoints from build-runtime-artifacts.mjs",
        );
    }

    return workers;
}

async function parseSupervisorWorkers() {
    const source = await readFile(SUPERVISOR_PATH, "utf8");
    const processNames = new Set();
    const artifactNames = new Set();
    const pattern =
        /\(\s*"(indexer-[a-z0-9-]+)"\s*,\s*"indexer\/dist-desktop\/([a-z0-9-]+)\.mjs"\s*,?\s*\)/g;

    for (const match of source.matchAll(pattern)) {
        processNames.add(match[1]);
        artifactNames.add(match[2]);
    }

    if (artifactNames.size === 0) {
        throw new Error("Failed to parse INDEXER_WORKERS from supervisor.rs");
    }

    return { processNames, artifactNames };
}

async function parseIndexerDevScripts() {
    const source = await readFile(INDEXER_PACKAGE_JSON_PATH, "utf8");
    const packageJson = JSON.parse(source);
    const scripts = packageJson.scripts ?? {};
    const workers = new Set();

    for (const key of Object.keys(scripts)) {
        const match = key.match(/^dev:([a-z0-9-]+-worker)$/);
        if (match) {
            workers.add(match[1]);
        }
    }

    return workers;
}

async function parseDevLauncherWorkers() {
    const source = await readFile(INDEXER_DEV_SCRIPT_PATH, "utf8");
    const processNames = new Set();
    const scriptWorkers = new Set();
    const pattern =
        /start_worker\s+"(indexer-[a-z0-9-]+)"\s+"dev:([a-z0-9-]+-worker)"/g;

    for (const match of source.matchAll(pattern)) {
        processNames.add(match[1]);
        scriptWorkers.add(match[2]);
    }

    return { processNames, scriptWorkers };
}

async function parsePrometheusRuntimes() {
    const source = await readFile(PROMETHEUS_CONFIG_PATH, "utf8");
    const runtimes = new Set();
    const pattern = /runtime:\s*"([a-z0-9-]+)"/g;

    for (const match of source.matchAll(pattern)) {
        runtimes.add(match[1]);
    }

    return runtimes;
}

async function parseMetricsConfigKeys() {
    const source = await readFile(INDEXER_CONFIG_PATH, "utf8");
    const keys = new Set();
    const pattern = /\b([a-zA-Z][a-zA-Z0-9]*)\s*:\s*parseNumber\(/g;

    for (const match of source.matchAll(pattern)) {
        keys.add(match[1]);
    }

    return keys;
}

async function parseMetricsEnvVars() {
    const source = await readFile(ENV_EXAMPLE_PATH, "utf8");
    const vars = new Set();
    const pattern = /^(METRICS_PORT_[A-Z0-9_]+)=/gm;

    for (const match of source.matchAll(pattern)) {
        vars.add(match[1]);
    }

    return vars;
}

async function main() {
    const errors = [];

    const runtimeWorkers = await parseBuildArtifacts();
    const { processNames: supervisorProcessNames, artifactNames: supervisorWorkers } =
        await parseSupervisorWorkers();
    const devScriptWorkers = await parseIndexerDevScripts();
    const {
        processNames: devLauncherProcessNames,
        scriptWorkers: devLauncherWorkers,
    } = await parseDevLauncherWorkers();
    const prometheusRuntimes = await parsePrometheusRuntimes();
    const metricsConfigKeys = await parseMetricsConfigKeys();
    const metricsEnvVars = await parseMetricsEnvVars();

    assertNoMissingEntries({
        source: "supervisor INDEXER_WORKERS artifacts",
        expected: runtimeWorkers,
        actual: supervisorWorkers,
        errors,
    });
    assertNoUnknownEntries({
        source: "supervisor INDEXER_WORKERS artifacts",
        expected: runtimeWorkers,
        actual: supervisorWorkers,
        errors,
    });

    assertNoMissingEntries({
        source: "indexer/package.json dev:* scripts",
        expected: runtimeWorkers,
        actual: devScriptWorkers,
        errors,
    });
    assertNoUnknownEntries({
        source: "indexer/package.json dev:* scripts",
        expected: runtimeWorkers,
        actual: devScriptWorkers,
        errors,
    });

    assertNoMissingEntries({
        source: "scripts/indexer-dev.sh worker scripts",
        expected: runtimeWorkers,
        actual: devLauncherWorkers,
        errors,
    });
    assertNoUnknownEntries({
        source: "scripts/indexer-dev.sh worker scripts",
        expected: runtimeWorkers,
        actual: devLauncherWorkers,
        errors,
    });

    const expectedProcessNames = new Set(
        [...runtimeWorkers].map((name) => `indexer-${name}`),
    );
    assertNoMissingEntries({
        source: "supervisor INDEXER_WORKERS process names",
        expected: expectedProcessNames,
        actual: supervisorProcessNames,
        errors,
    });
    assertNoUnknownEntries({
        source: "supervisor INDEXER_WORKERS process names",
        expected: expectedProcessNames,
        actual: supervisorProcessNames,
        errors,
    });
    assertNoMissingEntries({
        source: "scripts/indexer-dev.sh process names",
        expected: expectedProcessNames,
        actual: devLauncherProcessNames,
        errors,
    });
    assertNoUnknownEntries({
        source: "scripts/indexer-dev.sh process names",
        expected: expectedProcessNames,
        actual: devLauncherProcessNames,
        errors,
    });

    const expectedPrometheusRuntimes = new Set(
        [...runtimeWorkers].map((name) => toMetricsRuntime(name)),
    );
    assertNoMissingEntries({
        source: "observability/prometheus runtime labels",
        expected: expectedPrometheusRuntimes,
        actual: prometheusRuntimes,
        errors,
    });
    assertNoUnknownEntries({
        source: "observability/prometheus runtime labels",
        expected: expectedPrometheusRuntimes,
        actual: prometheusRuntimes,
        errors,
    });

    const expectedMetricsKeys = new Set(
        [...runtimeWorkers].map((name) => toMetricsConfigKey(name)),
    );
    assertNoMissingEntries({
        source: "indexer config metrics.ports keys",
        expected: expectedMetricsKeys,
        actual: metricsConfigKeys,
        errors,
    });
    assertNoMissingEntries({
        source: ".env.example metrics env vars",
        expected: new Set([...runtimeWorkers].map((name) => toMetricsEnvVar(name))),
        actual: metricsEnvVars,
        errors,
    });

    if (errors.length > 0) {
        console.error("Runtime registry consistency check failed:\n");
        for (const error of errors) {
            console.error(`- ${error}`);
        }
        process.exit(1);
    }

    console.log("Runtime registry consistency check passed.");
    console.log(`Workers: ${formatSet(runtimeWorkers)}`);
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
