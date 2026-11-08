import assert from "node:assert/strict";
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    stat,
    symlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    hashFile,
    pinFile,
    assertWorktreeTemporaryPath,
} from "./artifacts.mjs";
import { executeCommand } from "./qemu-replay.mjs";
import { CPU_MODEL } from "./cpu-model.mjs";
import {
    prepareCase,
    prepareScenarioDisk,
    SCENARIO_DISK_BYTES,
} from "./prepare-case.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const okay = (stdout = "") => ({
    code: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
});

async function fixture() {
    const parent = path.join(ROOT, "tmp", "prepare-case-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, "run-"));
    const scenarioFile = path.join(directory, "source.json");
    const scenario = JSON.parse(
        await readFile(
            new URL("./scenarios/baseline.json", import.meta.url),
            "utf8",
        ),
    );
    await writeFile(scenarioFile, JSON.stringify(scenario));
    const pins = {};
    for (const name of [
        "qemu",
        "qemuImg",
        "firmware",
        "kernel",
        "guest",
        "scenario",
    ]) {
        const filename = path.join(directory, name);
        await writeFile(filename, `synthetic ${name} input; not a VM`);
        pins[name] = {
            ...(await pinFile(filename)),
            ...(["qemu", "qemuImg"].includes(name)
                ? { version: `${name} test version` }
                : {}),
        };
    }
    const base = {
        version: 1,
        sourceSha: "b".repeat(40),
        qualificationId: "old-qualification",
        expectedChecks: ["old-check"],
        machine: "pc-i440fx-9.2",
        cpu: CPU_MODEL.Max,
        epoch: "2026-11-08T00:00:00Z",
        timeoutSeconds: 30,
        ...pins,
    };
    const baseManifestPath = path.join(directory, "base.json");
    await writeFile(baseManifestPath, JSON.stringify(base));
    const calls = [];
    const execute = async (file, args) => {
        calls.push({ file, args });
        if (args[0] === "--version")
            return okay(
                file === pins.qemu.path
                    ? pins.qemu.version
                    : pins.qemuImg.version,
            );
        if (args[0] === "-machine")
            return okay("pc-i440fx-9.2 fixed machine\n");
        if (args[0] === "info")
            return okay(
                JSON.stringify({ format: "qcow2", "virtual-size": 8388608 }),
            );
        if (file === "mke2fs") return okay();
        throw new Error("Case preparation must not execute a VM");
    };
    return {
        directory,
        scenarioFile,
        scenario,
        base,
        baseManifestPath,
        execute,
        calls,
    };
}

test("real scenario disk contains the validated immutable JSON and requires no runtime image rebuild", async () => {
    const f = await fixture();
    const prepared = await prepareScenarioDisk({
        scenarioFile: f.scenarioFile,
        directory: path.join(f.directory, "payload"),
    });
    assert.equal((await stat(prepared.diskPath)).size, SCENARIO_DISK_BYTES);
    assert.equal((await stat(prepared.diskPath)).mode & 0o222, 0);
    assert.equal((await stat(prepared.scenarioPath)).mode & 0o222, 0);
    const read = await executeCommand(
        "debugfs",
        ["-R", "cat /scenario.json", prepared.diskPath],
        {
            timeoutMs: 30_000,
            env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
        },
    );
    assert.equal(read.code, 0);
    assert.deepEqual(JSON.parse(read.stdout), f.scenario);
    const before = await hashFile(prepared.diskPath);
    await writeFile(f.scenarioFile, "source changed after preparation");
    assert.equal(await hashFile(prepared.diskPath), before);
    assert.deepEqual(
        JSON.parse(await readFile(prepared.scenarioPath, "utf8")),
        f.scenario,
    );
});

test("case manifests reuse admitted runtime pins and replace only the explicit case input and check identity", async () => {
    const f = await fixture();
    const prepared = await prepareCase({
        ...f,
        outputRoot: path.join(f.directory, "cases"),
    });
    for (const name of ["qemu", "qemuImg", "firmware", "kernel", "guest"])
        assert.deepEqual(prepared.manifest[name], f.base[name]);
    assert.equal(prepared.manifest.sourceSha, f.base.sourceSha);
    assert.equal(prepared.manifest.cpu, f.base.cpu);
    assert.equal(prepared.manifest.qualificationId, f.scenario.qualificationId);
    assert.deepEqual(
        prepared.manifest.expectedChecks,
        f.scenario.expectedChecks,
    );
    assert.notEqual(prepared.manifest.scenario.sha256, f.base.scenario.sha256);
    assert.equal(prepared.manifest.scenario.sizeBytes, SCENARIO_DISK_BYTES);
    assert.equal((await stat(prepared.manifestPath)).mode & 0o222, 0);
    assert.equal(f.calls.filter(({ file }) => file === "mke2fs").length, 1);
    assert.ok(!f.calls.some(({ args }) => args.includes("-icount")));
});

test("unknown scenario inputs fail before creating a case or invoking any tool", async () => {
    const f = await fixture();
    await writeFile(
        f.scenarioFile,
        JSON.stringify({
            ...f.scenario,
            environment: { NATS_URL: "nats://operator" },
        }),
    );
    await assert.rejects(
        prepareCase({ ...f, outputRoot: path.join(f.directory, "cases") }),
        /Unknown scenario field/,
    );
    assert.equal(f.calls.length, 0);
    assert.ok(!(await readdir(f.directory)).includes("cases"));
});

test("nonempty output and symlink escapes cannot replace existing artifacts", async () => {
    const f = await fixture();
    const existing = path.join(f.directory, "existing");
    await mkdir(existing);
    await writeFile(path.join(existing, "keep"), "unchanged");
    await assert.rejects(
        prepareScenarioDisk({ ...f, directory: existing }),
        /fresh and empty/,
    );
    assert.equal(
        await readFile(path.join(existing, "keep"), "utf8"),
        "unchanged",
    );
    const redirected = path.join(f.directory, "outside");
    await symlink(ROOT, redirected);
    await assert.rejects(
        assertWorktreeTemporaryPath(path.join(redirected, "not-created")),
        /symlink escapes/,
    );
});

test("filesystem tool failures retain inputs without producing a usable manifest", async () => {
    const f = await fixture();
    const directory = path.join(f.directory, "failed");
    await assert.rejects(
        prepareScenarioDisk({
            ...f,
            directory,
            execute: async () => ({ ...okay(), code: 1 }),
        }),
        /filesystem creation failed/,
    );
    assert.deepEqual(
        JSON.parse(
            await readFile(
                path.join(directory, "payload/scenario.json"),
                "utf8",
            ),
        ),
        f.scenario,
    );
    assert.ok(!(await readdir(directory)).includes("manifest.json"));
});

test("a cached runtime changed during case preparation is rejected by the final preflight", async () => {
    const f = await fixture();
    const execute = async (file, args) => {
        const result = await f.execute(file, args);
        if (file === "mke2fs")
            await writeFile(f.base.guest.path, "modified cached runtime");
        return result;
    };
    await assert.rejects(
        prepareCase({
            ...f,
            execute,
            outputRoot: path.join(f.directory, "cases"),
        }),
        /Pinned guest/,
    );
});
