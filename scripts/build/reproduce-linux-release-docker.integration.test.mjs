import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// This separate maintained lane requires an image built by the remote-only
// launcher. Source suites never skip Docker checks or start jobs implicitly.
const runnerImage = process.env.ARTGOD_REPRO_TEST_RUNNER_IMAGE;
const revision = process.env.ARTGOD_REPRO_TEST_REVISION;
assert.match(
    runnerImage ?? "",
    /^sha256:[a-f0-9]{64}$/,
    "ARTGOD_REPRO_TEST_RUNNER_IMAGE is required.",
);
assert.match(
    revision ?? "",
    /^[a-f0-9]{40}$/,
    "ARTGOD_REPRO_TEST_REVISION is required.",
);
const rootDir = fileURLToPath(new URL("../../", import.meta.url));

function docker(args, allowFailure = false) {
    const result = spawnSync("docker", args, { encoding: "utf8" });
    assert.equal(result.error, undefined);
    if (!allowFailure) assert.equal(result.status, 0, result.stderr);
    return result;
}

async function failedJob({ requestedRevision, network }) {
    await mkdir(path.join(rootDir, "tmp"), { recursive: true });
    const evidence = await mkdtemp(
        path.join(rootDir, "tmp", "docker-native-boundary-"),
    );
    const cidFile = path.join(evidence, "container-id.txt");
    const createArgs = [
        "create",
        "--platform",
        "linux/amd64",
        "--init",
        "--cidfile",
        cidFile,
    ];
    if (network) createArgs.push("--network", network);
    createArgs.push(
        "--env",
        "ARTGOD_REPRO_REPOSITORY=https://github.com/d347h-eth/artgod.git",
        "--env",
        `ARTGOD_REPRO_REVISION=${requestedRevision}`,
        runnerImage,
    );
    const id = docker(createArgs).stdout.trim();
    let collected = false;
    try {
        const start = docker(["start", "--attach", id], true);
        const inspection = JSON.parse(docker(["inspect", id]).stdout)[0];
        assert.equal(inspection.Config.User, "runner");
        assert.equal(inspection.HostConfig.Init, true);
        assert.deepEqual(inspection.Mounts, []);
        assert.equal(inspection.State.Running, false);
        assert.notEqual(inspection.State.ExitCode, 0);
        assert.equal(start.status, inspection.State.ExitCode);
        await writeFile(
            path.join(evidence, "container-state.json"),
            `${JSON.stringify(inspection.State, null, 2)}\n`,
        );
        await writeFile(
            path.join(evidence, "container.log"),
            docker(["logs", id]).stdout,
        );
        const output = path.join(evidence, "result");
        await mkdir(output);
        docker(["cp", `${id}:/home/runner/result/.`, output]);
        assert.equal(
            (await stat(path.join(output, "evidence/job.json"))).uid,
            os.userInfo().uid,
        );
        const record = JSON.parse(
            await readFile(path.join(output, "evidence/job.json"), "utf8"),
        );
        assert.equal(record.status, "failed");
        collected = true;
        return record;
    } finally {
        if (collected) docker(["rm", id]);
        else
            console.error(
                `Native boundary collection incomplete; retained container ${id}, evidence ${evidence}.`,
            );
    }
}

test("the committed runner rejects a recipe/checkout identity mismatch and exports diagnostics", async () => {
    const image = JSON.parse(
        docker(["image", "inspect", runnerImage]).stdout,
    )[0];
    assert.equal(
        image.Config.Labels["org.opencontainers.image.revision"],
        revision,
    );
    assert.equal(image.Os, "linux");
    assert.equal(image.Architecture, "amd64");
    const differentRevision =
        (revision[0] === "a" ? "b" : "a") + revision.slice(1);
    const record = await failedJob({ requestedRevision: differentRevision });
    assert.match(
        record.error,
        /recipe and requested checkout revisions differ/,
    );
    assert.deepEqual(record.checks, []);
});

test("an internal source-fetch failure is recorded and collectible without host mounts", async () => {
    const record = await failedJob({
        requestedRevision: revision,
        network: "none",
    });
    assert.equal(record.requestedRevision, revision);
    assert.equal(record.checks.at(-1).label, "Fetch committed revision");
    assert.equal(record.checks.at(-1).status, "failed");
});

test("the runner reaps orphaned descendants after their parent exits", async () => {
    const evidence = await mkdtemp(
        path.join(rootDir, "tmp", "docker-native-reaping-"),
    );
    // This console-only fixture exercises the container lifecycle, independently
    // of application packaging. Its short-lived grandchild becomes an orphan;
    // the job process must not inherit PID 1's responsibility to reap it.
    const parentProgram = `
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath,
            ["--eval", "setTimeout(() => {}, 600)"], { stdio: "ignore" });
        console.log(child.pid);
        child.unref();
    `;
    const program = `
        import { spawn } from "node:child_process";
        import { readFile } from "node:fs/promises";
        import { setTimeout } from "node:timers/promises";
        const parent = spawn(process.execPath,
            ["--eval", ${JSON.stringify(parentProgram)}],
            { stdio: ["ignore", "pipe", "inherit"] });
        let output = "";
        parent.stdout.on("data", chunk => output += chunk);
        const exit = await new Promise(resolve => parent.on("close", resolve));
        if (exit !== 0) throw new Error("Orphan fixture parent failed.");
        const pid = Number(output.trim());
        if (!Number.isInteger(pid) || pid < 2) throw new Error("Invalid fixture PID.");
        let state;
        const deadline = Date.now() + 10000;
        do {
            try {
                const stat = await readFile("/proc/" + pid + "/stat", "utf8");
                state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
                state = "reaped";
                break;
            }
            await setTimeout(25);
        } while (Date.now() < deadline);
        console.log(JSON.stringify({ pid, state,
            init: (await readFile("/proc/1/comm", "utf8")).trim() }));
        process.exitCode = state === "reaped" ? 0 : 1;
    `;
    const id = docker([
        "create",
        "--platform",
        "linux/amd64",
        "--init",
        "--network",
        "none",
        "--entrypoint",
        "/usr/local/libexec/artgod-bootstrap-node",
        runnerImage,
        "--input-type=module",
        "--eval",
        program,
    ]).stdout.trim();
    let collected = false;
    try {
        const start = docker(["start", "--attach", id], true);
        const inspection = JSON.parse(docker(["inspect", id]).stdout)[0];
        await writeFile(
            path.join(evidence, "result.json"),
            `${JSON.stringify({ state: inspection.State, start }, null, 2)}\n`,
        );
        collected = true;
        assert.equal(start.status, 0, start.stdout + start.stderr);
        assert.equal(inspection.Config.User, "runner");
        assert.equal(inspection.HostConfig.Init, true);
        assert.deepEqual(inspection.Mounts, []);
        assert.equal(JSON.parse(start.stdout).state, "reaped");
    } finally {
        if (collected) docker(["rm", id]);
        else
            console.error(
                `Reaping evidence incomplete; retained container ${id}, evidence ${evidence}.`,
            );
    }
});
