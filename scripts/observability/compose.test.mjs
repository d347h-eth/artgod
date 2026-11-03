import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    buildComposeArgs,
    OBSERVABILITY_COMPOSE_MODES as MODES,
    OBSERVABILITY_SERVICE_NAMES,
} from "./compose.mjs";
import {
    DEFAULT_OBSERVABILITY_PROJECT,
    loadObservabilityConfig,
    LOCAL_ENV_FILE,
    observabilityComposeEnvironment,
    OBSERVABILITY_ENV,
    OBSERVABILITY_PORTS,
    parseObservabilityArgs,
    prepareObservabilityInputs,
} from "./local-config.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

async function fixture() {
    await mkdir(path.join(projectRoot, "tmp"), { recursive: true });
    const root = await mkdtemp(
        path.join(projectRoot, "tmp/observability-test-"),
    );
    await mkdir(path.join(root, "observability/prometheus"), {
        recursive: true,
    });
    for (const relative of [
        "docker-compose.yml",
        "observability/prometheus/targets.json",
    ]) {
        await copyFile(
            path.join(projectRoot, relative),
            path.join(root, relative),
        );
    }
    return root;
}

function load(root, args = [], env = {}) {
    return loadObservabilityConfig(parseObservabilityArgs(args), root, env);
}

test("default project is stable across checkouts and commands stay scoped to collectors", async () => {
    const first = await load(await fixture());
    const second = await load(await fixture());
    assert.equal(first.projectName, DEFAULT_OBSERVABILITY_PROJECT);
    assert.equal(first.projectName, second.projectName);
    for (const mode of [MODES.up, MODES.stop, MODES.down]) {
        const args = buildComposeArgs(mode, first);
        assert.equal(
            args[args.indexOf("--project-name") + 1],
            first.projectName,
        );
        assert.equal(
            args[args.indexOf("--file") + 1],
            path.join(first.rootDir, "docker-compose.yml"),
        );
        assert.deepEqual(
            args.slice(-OBSERVABILITY_SERVICE_NAMES.length),
            OBSERVABILITY_SERVICE_NAMES,
        );
        assert.ok(!args.includes("nats") && !args.includes("natsbox"));
        assert.ok(
            !args.includes("--volumes") && !args.includes("--remove-orphans"),
        );
    }
    assert.ok(buildComposeArgs(MODES.down, first).includes("rm"));
});

test("CLI overrides shell env, then local defaults; target overrides retain job/runtime labels", async () => {
    const root = await fixture();
    await writeFile(
        path.join(root, LOCAL_ENV_FILE),
        [
            `${OBSERVABILITY_PORTS.grafana.env}=43035`,
            `${OBSERVABILITY_ENV.projectName}=file-project`,
            `${OBSERVABILITY_ENV.logsDir}="logs with spaces"`,
            `${OBSERVABILITY_ENV.metricsPorts}=bidding-bot=43054,sync-worker=43042`,
        ].join("\n"),
    );
    const env = {
        [OBSERVABILITY_PORTS.grafana.env]: "43135",
        [OBSERVABILITY_ENV.projectName]: "shell-project",
    };
    assert.equal((await load(root)).ports.grafana, 43035);
    assert.equal((await load(root, [], env)).ports.grafana, 43135);
    const config = await load(
        root,
        [
            "--port",
            "grafana=43235",
            "--port",
            "loki=43230",
            "--metrics-port",
            "bidding-bot=43254",
            "--project-name",
            "cli-project",
        ],
        env,
    );
    assert.equal(config.ports.grafana, 43235);
    assert.equal(config.ports.loki, 43230);
    assert.equal(config.projectName, "cli-project");
    const repaired = await load(
        root,
        ["--port", "grafana=43235", "--metrics-port", "bidding-bot=43254"],
        {
            [OBSERVABILITY_PORTS.grafana.env]: "invalid",
            [OBSERVABILITY_ENV.metricsPorts]: "bidding-bot=invalid",
        },
    );
    assert.equal(repaired.ports.grafana, 43235);
    assert.equal(config.logsDir, path.join(root, "logs with spaces"));
    const original = JSON.parse(
        await readFile(
            path.join(root, "observability/prometheus/targets.json"),
            "utf8",
        ),
    );
    assert.deepEqual(
        config.targets.map(({ labels }) => labels),
        original.map(({ labels }) => labels),
    );
    assert.deepEqual(
        config.targets.find(({ labels }) => labels.runtime === "bidding-bot")
            .targets,
        ["127.0.0.1:43254"],
    );
    assert.deepEqual(
        config.targets.find(({ labels }) => labels.runtime === "sync-worker")
            .targets,
        ["127.0.0.1:43042"],
    );
    assert.deepEqual(
        config.targets.find(({ labels }) => labels.runtime === "backend-api"),
        original.find(({ labels }) => labels.runtime === "backend-api"),
    );
});

test("invalid ports, names, assignments and host port conflicts fail before Docker", async () => {
    const root = await fixture();
    for (const port of ["0", "65536", "-1", "12.5", "abc", ""]) {
        await assert.rejects(
            load(root, ["--port", `grafana=${port}`]),
            /Invalid TCP port/,
        );
    }
    for (const assignment of ["unknown=43000", "grafana", "grafana=1=2"]) {
        await assert.rejects(
            load(root, ["--port", assignment]),
            /Invalid --port/,
        );
    }
    await assert.rejects(
        load(root, ["--metrics-port", "missing-worker=43000"]),
        /Invalid --metrics-port/,
    );
    await assert.rejects(
        load(root, ["--port", `grafana=${OBSERVABILITY_PORTS.loki.port}`]),
        /assigned to both/,
    );
    const targets = JSON.parse(
        await readFile(
            path.join(root, "observability/prometheus/targets.json"),
            "utf8",
        ),
    );
    await assert.rejects(
        load(root, [
            "--port",
            `grafana=${targets[0].targets[0].split(":")[1]}`,
        ]),
        /assigned to both/,
    );
    await assert.rejects(
        load(root, ["--project-name", "../unsafe"]),
        /Project name/,
    );
    await assert.rejects(load(root, ["--logs-dir", ""]), /must not be empty/);
    await assert.rejects(load(root, ["--pull", "invalid"]), /--pull/);
    assert.throws(
        () => parseObservabilityArgs(["--unknown"]),
        /Unknown option/,
    );
    assert.throws(
        () => parseObservabilityArgs(["positional"]),
        /Unexpected argument/,
    );
});

test("explicit env files are required, strict, and do not load the app's .env", async () => {
    const root = await fixture();
    await writeFile(
        path.join(root, ".env"),
        `${OBSERVABILITY_PORTS.grafana.env}=43535\n`,
    );
    assert.equal(
        (await load(root)).ports.grafana,
        OBSERVABILITY_PORTS.grafana.port,
    );
    await assert.rejects(
        load(root, ["--env-file", "missing.env"]),
        /Cannot read observability env file/,
    );
    await writeFile(path.join(root, "custom.env"), "TYPO_PORT=43000\n");
    await assert.rejects(
        load(root, ["--env-file", "custom.env"]),
        /Unknown setting TYPO_PORT/,
    );
    await writeFile(
        path.join(root, "custom.env"),
        `${OBSERVABILITY_PORTS.grafana.env}=43535\n`,
    );
    assert.equal(
        (await load(root, ["--env-file", "custom.env"])).ports.grafana,
        43535,
    );
});

test("prepare resolves directory symlinks and refuses missing or non-directory app log paths", async () => {
    const root = await fixture();
    const missing = path.join(root, "missing logs");
    await assert.rejects(
        prepareObservabilityInputs(await load(root, ["--logs-dir", missing])),
        /Cannot read logs directory/,
    );
    await assert.rejects(stat(missing), { code: "ENOENT" });
    const file = path.join(root, "a-file");
    await writeFile(file, "");
    await assert.rejects(
        prepareObservabilityInputs(await load(root, ["--logs-dir", file])),
        /not a directory/,
    );
    const realLogs = path.join(root, "app logs $literal");
    await mkdir(realLogs);
    const linkedLogs = path.join(root, "linked logs");
    await symlink(realLogs, linkedLogs, "dir");
    const config = await load(root, ["--logs-dir", linkedLogs]);
    await prepareObservabilityInputs(config);
    assert.equal(config.logsDir, realLogs);
    assert.deepEqual(
        JSON.parse(await readFile(config.targetsFile, "utf8")),
        config.targets,
    );
});

test("default logs are created locally; stop/down do not need log directories", async () => {
    const root = await fixture();
    const config = await load(root);
    await prepareObservabilityInputs(config);
    assert.ok((await stat(path.join(root, "tmp/logs"))).isDirectory());
    const unavailable = await load(root, [
        "--logs-dir",
        "unmounted-external-logs",
    ]);
    assert.ok(buildComposeArgs(MODES.stop, unavailable).includes("stop"));
    assert.ok(buildComposeArgs(MODES.down, unavailable).includes("rm"));
});

test("Compose resolves every remap, datasource URL and read-only mount with app .env isolated", async () => {
    const root = await fixture();
    const logs = path.join(root, "app logs $literal");
    await mkdir(logs);
    await writeFile(
        path.join(root, ".env"),
        `${OBSERVABILITY_PORTS.grafana.env}=65535\n`,
    );
    const args = Object.keys(OBSERVABILITY_PORTS).flatMap((name, index) => [
        "--port",
        `${name}=${43430 + index}`,
    ]);
    const config = await load(root, [
        ...args,
        "--logs-dir",
        logs,
        "--metrics-port",
        "bidding-bot=43454",
    ]);
    await prepareObservabilityInputs(config);
    const inherited = {
        ...process.env,
        COMPOSE_FILE: "missing.yml",
        COMPOSE_PROJECT_NAME: "wrong-project",
        COMPOSE_ENV_FILES: "missing.env",
    };
    const env = observabilityComposeEnvironment(config, inherited);
    assert.equal(env.COMPOSE_ENV_FILES, undefined);
    const result = spawnSync("docker", buildComposeArgs(MODES.config, config), {
        cwd: projectRoot,
        env,
        encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const resolved = JSON.parse(result.stdout);
    assert.equal(resolved.name, config.projectName);
    const services = resolved.services;
    for (const [name, service, internal] of [
        ["loki", "loki", OBSERVABILITY_PORTS.loki.port],
        ["tempo", "tempo", OBSERVABILITY_PORTS.tempo.port],
        ["otlp", "tempo", OBSERVABILITY_PORTS.otlp.port],
        ["pyroscope", "pyroscope", OBSERVABILITY_PORTS.pyroscope.port],
    ]) {
        const binding = services[service].ports.find(
            ({ target }) => target === internal,
        );
        assert.equal(binding.published, String(config.ports[name]));
        assert.equal(binding.host_ip, "127.0.0.1");
    }
    assert.equal(services.prometheus.network_mode, "host");
    assert.ok(
        services.prometheus.command.includes(
            `--web.listen-address=127.0.0.1:${config.ports.prometheus}`,
        ),
    );
    assert.equal(
        services.grafana.environment.GF_SERVER_HTTP_PORT,
        String(config.ports.grafana),
    );
    assert.equal(services.grafana.environment.GF_SERVER_HTTP_ADDR, "127.0.0.1");
    for (const name of ["loki", "tempo", "pyroscope", "prometheus"]) {
        assert.equal(
            services.grafana.environment[
                `ARTGOD_OBSERVABILITY_${name.toUpperCase()}_URL`
            ],
            `http://127.0.0.1:${config.ports[name]}`,
        );
    }
    const logMount = services.alloy.volumes.find(
        ({ target }) => target === "/var/log/artgod",
    );
    // `compose config` escapes literal dollars so its output can be re-used as YAML.
    assert.equal(logMount.source.replaceAll("$$", "$"), logs);
    assert.equal(logMount.read_only, true);
    assert.equal(logMount.bind?.create_host_path ?? false, false);
    const targetsMount = services.prometheus.volumes.find(
        ({ target }) => target === "/etc/prometheus/targets.json",
    );
    assert.equal(targetsMount.source, config.targetsFile);
    assert.equal(targetsMount.read_only, true);
    assert.ok(
        services.alloy.volumes.some(
            ({ type, target }) =>
                type === "volume" && target === "/var/lib/alloy/data",
        ),
    );
    assert.equal(services.alloy.ports, undefined);
});

test("help and invalid CLI invocations work without Docker", () => {
    const script = path.join(projectRoot, "scripts/observability/compose.mjs");
    const env = { ...process.env, PATH: "" };
    const help = spawnSync(process.execPath, [script, MODES.up, "--help"], {
        env,
        encoding: "utf8",
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--metrics-port/);
    const invalid = spawnSync(process.execPath, [script, "invalid"], {
        env,
        encoding: "utf8",
    });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Use yarn observability:up/);
});
