import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertPinnedInputAge } from "./pinned-build-inputs.mjs";
import { DEFAULT_MINIMUM_AGE_DAYS } from "../security/dependency-age-policy.mjs";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const revision = "c".repeat(40);
const launcher = "scripts/build/reproduce-linux-release-docker.sh";

async function fixture(environment = {}, linked = false) {
    await mkdir(path.join(rootDir, "tmp"), { recursive: true });
    const directory = await mkdtemp(
        path.join(rootDir, "tmp", "docker-launcher-test-"),
    );
    await mkdir(path.join(directory, "scripts/build"), { recursive: true });
    await mkdir(path.join(directory, "bin"));
    if (linked)
        await writeFile(
            path.join(directory, ".git"),
            "gitdir: unrelated-readonly-metadata\n",
        );
    else await mkdir(path.join(directory, ".git"));
    await copyFile(
        path.join(rootDir, launcher),
        path.join(directory, launcher),
    );
    const docker = path.join(directory, "bin/docker");
    await copyFile(
        path.join(
            rootDir,
            "scripts/build/fixtures/fake-reproduction-docker.mjs",
        ),
        docker,
    );
    await chmod(docker, 0o755);
    const state = path.join(directory, "state.json");
    await writeFile(
        state,
        JSON.stringify({ running: environment.FAKE_RUNNING === "true" }),
    );
    return {
        directory,
        env: {
            ...process.env,
            ...environment,
            PATH: `${path.join(directory, "bin")}${path.delimiter}${process.env.PATH}`,
            FAKE_DOCKER_CALLS: path.join(directory, "calls.jsonl"),
            FAKE_DOCKER_STATE: state,
        },
        async calls() {
            return (await readFile(path.join(directory, "calls.jsonl"), "utf8"))
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line));
        },
        async result() {
            return path.join(
                directory,
                "tmp",
                (await readdir(path.join(directory, "tmp")))[0],
            );
        },
    };
}

function run(f, args = [revision]) {
    return spawnSync("bash", [path.join(f.directory, launcher), ...args], {
        cwd: f.directory,
        env: f.env,
        encoding: "utf8",
    });
}

test("ordinary and linked launchers use only remote committed input and export before removal", async () => {
    for (const linked of [false, true]) {
        const f = await fixture({}, linked);
        const result = run(f);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 0, result.stderr);
        const calls = await f.calls();
        const build = calls.find((args) => args[0] === "buildx");
        assert.equal(
            build.at(-1),
            `https://github.com/d347h-eth/artgod.git#${revision}`,
        );
        assert.ok(build.includes("--no-cache"));
        assert.ok(build.includes("--pull"));
        for (const args of calls)
            assert.ok(
                !args.some((arg) =>
                    [
                        "--mount",
                        "--volume",
                        "-v",
                        "--privileged",
                        "--rm",
                    ].includes(arg),
                ),
            );
        const create = calls.find((args) => args[0] === "create");
        assert.equal(create.at(-1), `sha256:${"a".repeat(64)}`);
        assert.ok(
            calls.findIndex((args) => args[0] === "cp") <
                calls.findIndex((args) => args[0] === "rm"),
        );
        assert.ok(!calls.find((args) => args[0] === "cp").includes("-a"));
        assert.equal(
            await readFile(
                path.join(await f.result(), "evidence/fixture-job.json"),
                "utf8",
            ),
            '{"exported":true}',
        );
    }
});

test("build and job failures retain diagnostics and their original status", async () => {
    const imageFailure = await fixture({ FAKE_BUILD_FAILURE: "37" });
    assert.equal(run(imageFailure).status, 37);
    assert.deepEqual(
        (await imageFailure.calls()).map((args) => args[0]),
        ["buildx"],
    );
    const jobFailure = await fixture({ FAKE_JOB_STATUS: "17" });
    assert.equal(run(jobFailure).status, 17);
    const calls = await jobFailure.calls();
    assert.ok(calls.some((args) => args[0] === "logs"));
    assert.ok(calls.some((args) => args[0] === "cp"));
    assert.ok(calls.some((args) => args[0] === "rm"));
    assert.match(
        await readFile(
            path.join(await jobFailure.result(), "container.log"),
            "utf8",
        ),
        /job diagnostics/,
    );
});

test("export failure keeps the uncollected container and cannot hide a job failure", async () => {
    for (const jobStatus of ["0", "17"]) {
        const f = await fixture({
            FAKE_EXPORT_FAILURE: "1",
            FAKE_JOB_STATUS: jobStatus,
        });
        const result = run(f);
        assert.equal(
            result.status,
            jobStatus === "0" ? 125 : Number(jobStatus),
        );
        assert.match(result.stderr, /retained job/);
        assert.ok(!(await f.calls()).some((args) => args[0] === "rm"));
    }
});

test("interruption stops only the owned job and exports it before cleanup", async () => {
    const f = await fixture({ FAKE_RUNNING: "true" });
    const ready = path.join(f.directory, "ready");
    f.env.FAKE_START_WAIT = ready;
    const child = spawn("bash", [path.join(f.directory, launcher), revision], {
        cwd: f.directory,
        env: f.env,
        stdio: "ignore",
    });
    const completion = new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => resolve(code));
    });
    const deadline = Date.now() + 10_000;
    while (true) {
        try {
            await readFile(ready);
            break;
        } catch (error) {
            if (error.code !== "ENOENT" || Date.now() > deadline) throw error;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
    child.kill("SIGTERM");
    assert.equal(await completion, 143);
    const calls = await f.calls();
    const stop = calls.find((args) => args[0] === "stop");
    assert.equal(stop.at(-1), "b".repeat(64));
    assert.ok(
        calls.findIndex((args) => args[0] === "stop") <
            calls.findIndex((args) => args[0] === "cp"),
    );
    assert.ok(
        calls.findIndex((args) => args[0] === "cp") <
            calls.findIndex((args) => args[0] === "rm"),
    );
});

test("invalid revision is rejected before provisioning", async () => {
    const f = await fixture();
    assert.equal(run(f, ["main"]).status, 64);
    await assert.rejects(readFile(path.join(f.directory, "calls.jsonl")), {
        code: "ENOENT",
    });
});

test("reviewed reproduction images are digest pinned and pass the shared age policy", async () => {
    const recipe = await readFile(
        path.join(
            rootDir,
            "scripts/build/linux-release-reproduction/Dockerfile",
        ),
        "utf8",
    );
    for (const input of ["UBUNTU", "NODE_BOOTSTRAP"]) {
        const reference = recipe.match(
            new RegExp(`^ARG ${input}_IMAGE=(.+)$`, "m"),
        )?.[1];
        assert.match(reference, /@sha256:[a-f0-9]{64}$/);
        const publishedAt = recipe.match(
            new RegExp(`ARTGOD_REPRO_${input}_PUBLISHED_AT=(\\S+)`),
        )?.[1];
        assertPinnedInputAge(
            { fileName: input, publishedAt },
            DEFAULT_MINIMUM_AGE_DAYS,
        );
    }
});
