import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pinFile, hashFile } from "./artifacts.mjs";
import { DOCKER_OWNER_LABEL } from "./docker.mjs";
import { readInputPins } from "./input-pins.mjs";
import { qualify } from "./qemu-replay.mjs";
import {
    QUALIFICATION_PROTOCOL_PREFIX,
    SIMULATION_EVIDENCE_PREFIX,
} from "./qualification-protocol.mjs";
import {
    BUNDLE_EXPORT_STATUS,
    exportFailedRuns,
    exportReplayBundle,
} from "./portable-run.mjs";
import { replayRun } from "./replay-run.mjs";
import { restoreToolCapsule } from "./tool-capsule.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const IMAGE = `sha256:${"a".repeat(64)}`;
const okay = (stdout = "") => ({
    code: 0,
    stdout,
    stderr: "",
    signal: null,
    timedOut: false,
});

async function completedFixture() {
    const parent = path.join(ROOT, "tmp/simulation-portable-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, "run-"));
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
        await writeFile(filename, `synthetic pinned ${name}`);
        pins[name] = {
            ...(await pinFile(filename)),
            ...(["qemu", "qemuImg"].includes(name)
                ? { version: `${name} fixture version` }
                : {}),
        };
    }
    const archive = path.join(directory, "tool-image.tar");
    await writeFile(archive, "synthetic OCI image archive");
    const capsule = {
        version: 1,
        architecture: "amd64",
        imageId: IMAGE,
        archive: await pinFile(archive),
        tools: Object.fromEntries(
            ["qemu", "qemuImg", "firmware"].map((name) => [name, pins[name]]),
        ),
        build: {
            baseImage: (await readInputPins()).toolBaseImage,
            dockerfileSha256: "b".repeat(64),
        },
    };
    const capsuleFile = path.join(directory, "capsule.json");
    await writeFile(capsuleFile, JSON.stringify(capsule));
    const manifest = {
        version: 1,
        sourceSha: "c".repeat(40),
        qualificationId: "portable-fixture",
        expectedChecks: ["synthetic-check"],
        machine: "pc-i440fx-8.2",
        epoch: "2026-11-08T00:00:00Z",
        timeoutSeconds: 1,
        ...pins,
        toolCapsule: await pinFile(capsuleFile),
    };
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const serial =
        [
            `${QUALIFICATION_PROTOCOL_PREFIX}${JSON.stringify({ version: 1, qualificationId: manifest.qualificationId, event: "ready" })}`,
            `${SIMULATION_EVIDENCE_PREFIX}${JSON.stringify({ result: { checks: { "synthetic-check": true }, evidence: { checkpoint: "completed fixture" } } })}`,
            `${QUALIFICATION_PROTOCOL_PREFIX}${JSON.stringify({ version: 1, qualificationId: manifest.qualificationId, event: "complete", status: "passed", checks: { "synthetic-check": true } })}`,
        ].join("\n") + "\n";
    const containers = new Map();
    const modes = [];
    const backings = new Map();
    const execute = async (binary, args, options) => {
        assert.equal(binary, "docker");
        if (args[0] === "image")
            return okay(
                args[1] === "load"
                    ? "loaded synthetic image"
                    : JSON.stringify({
                          Id: IMAGE,
                          Architecture: "amd64",
                          Os: "linux",
                      }),
            );
        if (args[0] === "create") {
            const name = args[args.indexOf("--name") + 1];
            containers.set(name, {
                token: args[args.indexOf("--label") + 1].slice(
                    DOCKER_OWNER_LABEL.length + 1,
                ),
                command: args.slice(args.indexOf(IMAGE) + 1),
            });
            await writeFile(
                args[args.indexOf("--cidfile") + 1],
                "d".repeat(64),
            );
            return okay(`${"d".repeat(64)}\n`);
        }
        if (args[0] === "inspect")
            return okay(
                JSON.stringify({
                    [DOCKER_OWNER_LABEL]: containers.get(args.at(-1)).token,
                }),
            );
        if (args[0] === "rm") {
            containers.delete(args.at(-1));
            return okay();
        }
        if (args[0] !== "start")
            throw new Error(`Unexpected Docker command ${args}`);
        const command = containers.get(args.at(-1)).command;
        const file = command[5];
        const engineArgs = command.slice(6);
        if (engineArgs[0] === "--version")
            return okay(
                file.endsWith("qemu-img")
                    ? pins.qemuImg.version
                    : pins.qemu.version,
            );
        if (engineArgs[0] === "-machine")
            return okay("pc-i440fx-8.2 fixture\n");
        if (engineArgs[0] === "info")
            return okay(
                JSON.stringify({
                    format: "qcow2",
                    "virtual-size": 8388608,
                    ...(/(?:record|replay)\.qcow2$/.test(engineArgs.at(-1))
                        ? {
                              "backing-filename":
                                  backings.get(engineArgs.at(-1)) ??
                                  pins.guest.path,
                              "full-backing-filename":
                                  backings.get(engineArgs.at(-1)) ??
                                  pins.guest.path,
                              "backing-filename-format": "qcow2",
                          }
                        : {}),
                }),
            );
        if (engineArgs[0] === "rebase") {
            backings.set(
                engineArgs.at(-1),
                engineArgs[engineArgs.indexOf("-b") + 1],
            );
            return okay();
        }
        if (engineArgs[0] === "compare") return okay();
        if (engineArgs[0] === "create") {
            backings.set(
                engineArgs.at(-1),
                engineArgs[engineArgs.indexOf("-b") + 1],
            );
            await writeFile(engineArgs.at(-1), "synthetic overlay");
            return okay();
        }
        const clock = engineArgs[engineArgs.indexOf("-icount") + 1];
        const mode = clock.includes("rr=record") ? "record" : "replay";
        modes.push(mode);
        if (mode === "record")
            await writeFile(
                clock.split("rrfile=")[1],
                "immutable recorded event log",
            );
        await writeFile(options.stdoutPath, serial);
        await writeFile(options.stderrPath, "synthetic engine diagnostic");
        return okay();
    };
    const report = await qualify(manifestPath, {
        execute,
        outputRoot: path.join(directory, "original"),
    });
    const bundle = await exportReplayBundle({
        runDirectory: report.directory,
        outputRoot: path.join(directory, "exports"),
        execute,
    });
    return { directory, manifest, capsule, report, bundle, modes, execute };
}

test("portable export preserves original evidence and replays only relocated pinned files after original inputs change", async () => {
    const f = await completedFixture();
    for (const name of [
        "report.json",
        "input-manifest.json",
        "replay-command.json",
        "record-serial.log",
        "replay.bin",
    ])
        assert.equal(
            await hashFile(path.join(f.bundle.runDirectory, name)),
            await hashFile(path.join(f.report.directory, name)),
        );
    for (const pin of Object.values(f.manifest).filter(
        (value) => value && typeof value === "object" && value.path,
    ))
        await writeFile(pin.path, "original input no longer available");
    await writeFile(
        f.capsule.archive.path,
        "original archive no longer available",
    );
    await restoreToolCapsule(f.bundle.toolCapsuleFile, { execute: f.execute });
    const report = await replayRun({
        runDirectory: f.bundle.runDirectory,
        relocationFile: f.bundle.relocationFile,
        outputRoot: path.join(f.directory, "repeated"),
        execute: f.execute,
    });
    assert.deepEqual(f.modes, ["record", "replay", "replay"]);
    assert.equal(report.engineReplayStatus, "passed");
    assert.equal(report.guestDiskParityStatus, "passed");
    assert.equal(report.replayLogSha256, f.report.replayLogSha256);
    assert.equal(report.serialSha256, f.report.serialSha256);
    assert.equal(report.relocation.imageId, IMAGE);
    assert.equal(
        report.sourceReportSha256,
        await hashFile(path.join(f.report.directory, "report.json")),
    );
});

test("portable replay refuses changed images, input hashes, unknown path roles and arbitrary recorded QEMU arguments", async () => {
    for (const change of ["image", "guest", "role", "args"]) {
        const f = await completedFixture();
        const relocation = JSON.parse(
            await readFile(f.bundle.relocationFile, "utf8"),
        );
        if (change === "image") {
            const filename = path.join(
                f.bundle.directory,
                relocation.inputs.toolCapsule.path,
            );
            const descriptor = JSON.parse(await readFile(filename, "utf8"));
            descriptor.imageId = `sha256:${"e".repeat(64)}`;
            await writeFile(filename, JSON.stringify(descriptor));
            relocation.inputs.toolCapsule = await pinFile(
                filename,
                f.bundle.directory,
            );
        }
        if (change === "guest") {
            const filename = path.join(
                f.bundle.directory,
                relocation.inputs.guest.path,
            );
            await writeFile(filename, "changed guest bytes");
            relocation.inputs.guest = await pinFile(
                filename,
                f.bundle.directory,
            );
        }
        if (change === "role")
            relocation.inputs.hostNetworking = relocation.inputs.guest;
        if (change === "args") {
            const filename = path.join(
                f.bundle.runDirectory,
                "replay-command.json",
            );
            const command = JSON.parse(await readFile(filename, "utf8"));
            command.args.push("-netdev", "user,id=arbitrary");
            await writeFile(filename, JSON.stringify(command));
        }
        await writeFile(f.bundle.relocationFile, JSON.stringify(relocation));
        await assert.rejects(
            replayRun({
                runDirectory: f.bundle.runDirectory,
                relocationFile: f.bundle.relocationFile,
                execute: f.execute,
            }),
            /original byte pin|exactly|matching runner/,
        );
        assert.deepEqual(f.modes, ["record", "replay"]);
    }
});

test("failure export bounds complete copies and records every incomplete or omitted counterexample", async () => {
    const parent = path.join(ROOT, "tmp/simulation-portable-tests");
    await mkdir(parent, { recursive: true });
    const directory = await mkdtemp(path.join(parent, "batch-"));
    const runRoot = path.join(directory, "runs");
    await mkdir(runRoot);
    for (const [name, engineReplayStatus, propertyStatus] of [
        ["run-a", "passed", "failed"],
        ["run-b", "passed", "failed"],
        ["run-c", "failed", "unqualified"],
        ["run-d", "passed", "passed"],
    ]) {
        await mkdir(path.join(runRoot, name));
        await writeFile(
            path.join(runRoot, name, "report.json"),
            JSON.stringify({ engineReplayStatus, propertyStatus }),
        );
    }
    await mkdir(path.join(runRoot, "run-e"));
    const calls = [];
    const result = await exportFailedRuns({
        runRoot,
        outputRoot: path.join(directory, "exports"),
        maxBundles: 1,
        exportRun: async ({ runDirectory }) => {
            calls.push(runDirectory);
            return { directory: "synthetic-bundle" };
        },
    });
    assert.equal(result.eligibleProductFailures, 2);
    assert.equal(result.completeBundles, 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(
        result.entries.map(({ status }) => status),
        [
            BUNDLE_EXPORT_STATUS.Exported,
            BUNDLE_EXPORT_STATUS.Limited,
            BUNDLE_EXPORT_STATUS.Unqualified,
            BUNDLE_EXPORT_STATUS.Unqualified,
        ],
    );
    assert.equal(
        JSON.parse(await readFile(result.indexFile, "utf8")).entries.length,
        4,
    );
});
