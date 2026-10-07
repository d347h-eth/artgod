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
