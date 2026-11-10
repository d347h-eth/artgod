import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { pinFile, hashFile } from "./artifacts.mjs";
import { qualify } from "./qemu-replay.mjs";
import {
    QUALIFICATION_PROTOCOL_PREFIX,
    SIMULATION_EVIDENCE_PREFIX,
} from "./qualification-protocol.mjs";
import { replayRun } from "./replay-run.mjs";
import { readRunEvidence } from "./run-evidence.mjs";
import { CPU_MODEL } from "./cpu-model.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const okay = (stdout = "") => ({
    code: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
});

async function completedFixture(passed = true, cpu) {
    const parent = path.join(ROOT, "tmp", "simulation-exact-replay-tests");
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
    const manifest = {
        version: 1,
        sourceSha: "a".repeat(40),
        qualificationId: "exact-replay-case",
        expectedChecks: ["synthetic-check"],
        machine: "pc-i440fx-9.2",
        ...(cpu === undefined ? {} : { cpu }),
        epoch: "2026-11-08T00:00:00Z",
        timeoutSeconds: 1,
        ...pins,
    };
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const evidence = {
        world: { trace: [{ provider: "a", branch: "A" }] },
        checkpoints: [{ name: "guard-reached" }],
    };
    const coverage = [
        { check: "synthetic-check", status: passed ? "passed" : "failed" },
    ];
    const terminal = passed
        ? {
              result: {
                  checks: { "synthetic-check": true },
                  evidence: { ...evidence, coverage },
              },
          }
        : {
              failure: {
                  error: "deliberate product failure",
                  ...evidence,
                  coverage,
              },
          };
    const serial =
        [
            `${QUALIFICATION_PROTOCOL_PREFIX}${JSON.stringify({ version: 1, qualificationId: manifest.qualificationId, event: "ready" })}`,
            `${SIMULATION_EVIDENCE_PREFIX}${JSON.stringify({ probe: { now: 1234, entropy: "synthetic" } })}`,
            `${SIMULATION_EVIDENCE_PREFIX}${JSON.stringify(terminal)}`,
            `${QUALIFICATION_PROTOCOL_PREFIX}${JSON.stringify({ version: 1, qualificationId: manifest.qualificationId, event: "complete", status: passed ? "passed" : "failed", checks: { "synthetic-check": passed } })}`,
        ].join("\n") + "\n";
    const modes = [];
    const execute = async (file, args, options = {}) => {
        if (args[0] === "--version")
            return okay(
                file === pins.qemu.path
                    ? pins.qemu.version
                    : pins.qemuImg.version,
            );
        if (args[0] === "-machine") return okay("pc-i440fx-9.2 fixture\n");
        if (args[0] === "info")
            return okay(
                JSON.stringify({
                    format: "qcow2",
                    "virtual-size": 8388608,
                    ...(/(?:record|replay)\.qcow2$/.test(args.at(-1))
                        ? {
                              "backing-filename": pins.guest.path,
                              "full-backing-filename": pins.guest.path,
                              "backing-filename-format": "qcow2",
                          }
                        : {}),
                }),
            );
        if (args[0] === "compare") return okay();
        if (args[0] === "create") {
            await writeFile(args.at(-1), "synthetic overlay");
            return okay();
        }
        const clock = args[args.indexOf("-icount") + 1];
        const mode = clock.includes("rr=record") ? "record" : "replay";
        modes.push(mode);
        if (mode === "record")
            await writeFile(
                clock.split("rrfile=")[1],
                "immutable event recording",
            );
        await writeFile(options.stdoutPath, serial);
        await writeFile(options.stderrPath, "synthetic emulator diagnostic");
        return okay();
    };
    const report = await qualify(manifestPath, {
        execute,
        outputRoot: path.join(directory, "original"),
    });
    return {
        directory,
        manifest,
        serial,
        evidence,
        coverage,
        execute,
        modes,
        report,
    };
}

test("exact replay uses one fresh replay execution and the original recording for passing and failed product cases", async () => {
    for (const passed of [true, false]) {
        const f = await completedFixture(passed);
        const report = await replayRun({
            runDirectory: f.report.directory,
            execute: f.execute,
            outputRoot: path.join(f.directory, "repeated"),
        });
        assert.deepEqual(f.modes, ["record", "replay", "replay"]);
        assert.equal(report.engineReplayStatus, "passed");
        assert.equal(report.propertyStatus, passed ? "passed" : "failed");
        assert.equal(report.status, passed ? "passed" : "failed");
        assert.equal(report.mode, "replay-only");
        assert.equal(report.replayLogSha256, f.report.replayLogSha256);
        assert.equal(report.serialSha256, f.report.serialSha256);
        const read = await readRunEvidence(report.directory);
        assert.deepEqual(read.evidence.checkpoints, f.evidence.checkpoints);
        assert.deepEqual(read.coverage, f.coverage);
    }
});

test("arbitrary recorded arguments or changed clock profile are refused before another VM execution", async () => {
    for (const change of [
        (command) => command.args.push("-netdev", "user,id=unexpected"),
        (command) => {
            const index = command.args.indexOf("-icount") + 1;
            command.args[index] = command.args[index].replace(
                /shift=\d+/,
                "shift=24",
            );
        },
        (command) => {
            command.env.EXTRA = "unapproved";
        },
        (command) => {
            command.args[command.args.indexOf("-cpu") + 1] = CPU_MODEL.Max;
        },
    ]) {
        const f = await completedFixture();
        const filename = path.join(f.report.directory, "replay-command.json");
        const command = JSON.parse(await readFile(filename, "utf8"));
        change(command);
        await writeFile(filename, JSON.stringify(command));
        await assert.rejects(
            replayRun({
                runDirectory: f.report.directory,
                execute: f.execute,
                outputRoot: path.join(f.directory, "refused"),
            }),
            /restore the matching runner/,
        );
        assert.equal(f.modes.length, 2);
        assert.ok(!(await readdir(f.directory)).includes("refused"));
    }
});

test("exact replay preserves an explicit CPU pin through saved manifests and generated arguments", async () => {
    const f = await completedFixture(true, CPU_MODEL.Max);
    const report = await replayRun({
        runDirectory: f.report.directory,
        execute: f.execute,
        outputRoot: path.join(f.directory, "repeated"),
    });
    const saved = JSON.parse(
        await readFile(
            path.join(report.directory, "input-manifest.json"),
            "utf8",
        ),
    );
    const command = JSON.parse(
        await readFile(
            path.join(report.directory, "replay-command.json"),
            "utf8",
        ),
    );
    assert.equal(saved.cpu, CPU_MODEL.Max);
    assert.equal(command.args[command.args.indexOf("-cpu") + 1], CPU_MODEL.Max);
    assert.deepEqual(f.modes, ["record", "replay", "replay"]);
});

test("exact replay rejects changed pinned final disks and unexpected backing images", async () => {
    for (const change of ["bytes", "backing"]) {
        const f = await completedFixture();
        if (change === "bytes")
            await writeFile(
                path.join(f.report.directory, "record.qcow2"),
                "changed disk",
            );
        const execute = (file, args, options) =>
            change === "backing" &&
            args[0] === "info" &&
            /(?:record|replay)\.qcow2$/.test(args.at(-1))
                ? okay(
                      JSON.stringify({
                          format: "qcow2",
                          "backing-filename-format": "qcow2",
                          "backing-filename": "/unexpected/base",
                          "full-backing-filename": "/unexpected/base",
                      }),
                  )
                : f.execute(file, args, options);
        await assert.rejects(
            replayRun({ runDirectory: f.report.directory, execute }),
            /overlay changed|unexpected backing/,
        );
        assert.equal(f.modes.length, 2);
    }
});

test("changed original event log, serial or normalized manifest cannot silently become a new execution", async () => {
    for (const name of [
        "replay.bin",
        "record-serial.log",
        "input-manifest.json",
    ]) {
        const f = await completedFixture();
        await writeFile(path.join(f.report.directory, name), "tampered input");
        await assert.rejects(
            replayRun({ runDirectory: f.report.directory, execute: f.execute }),
            /digest|manifest changed/,
        );
        assert.equal(f.modes.length, 2);
    }
});

test("new replay divergence fails engine qualification and exposes a structured retained report", async () => {
    const f = await completedFixture(false);
    const execute = async (file, args, options) => {
        const result = await f.execute(file, args, options);
        if (args.includes("-icount"))
            await writeFile(
                options.stdoutPath,
                `changed serial bytes\n${f.serial}`,
            );
        return result;
    };
    await assert.rejects(
        replayRun({
            runDirectory: f.report.directory,
            execute,
            outputRoot: path.join(f.directory, "diverged"),
        }),
        (error) => {
            assert.equal(error.report.engineReplayStatus, "failed");
            assert.equal(error.report.propertyStatus, "failed");
            assert.equal(error.directory, error.report.directory);
            return /differs from the original/.test(error.message);
        },
    );
});

test("an engine failure before guest output reports checks as unreached rather than inventing passed evidence", async () => {
    const f = await completedFixture();
    const directory = path.join(f.directory, "no-guest");
    await mkdir(directory);
    await writeFile(
        path.join(directory, "report.json"),
        JSON.stringify({
            version: 1,
            status: "failed",
            engineReplayStatus: "failed",
            error: "emulator failed before ready",
        }),
    );
    await writeFile(
        path.join(directory, "input-manifest.json"),
        JSON.stringify(f.manifest),
    );
    const read = await readRunEvidence(directory);
    assert.deepEqual(read.coverage, [
        { check: "synthetic-check", status: "unreached" },
    ]);
    assert.equal(read.coverageGaps.length, 1);
    assert.equal(read.report.engineReplayStatus, "failed");
});

test("completed evidence cannot disappear or disagree with the reported checks even when serial bytes are otherwise recorded", async () => {
    for (const problem of [
        "missing-result",
        "wrong-result",
        "wrong-failure-coverage",
    ]) {
        const f = await completedFixture(problem !== "wrong-failure-coverage");
        const lines = f.serial.trimEnd().split("\n");
        const index = lines.findIndex(
            (line) =>
                line.startsWith(SIMULATION_EVIDENCE_PREFIX) &&
                !line.includes('"probe"'),
        );
        if (problem === "missing-result") lines.splice(index, 1);
        else {
            const message = JSON.parse(
                lines[index].slice(SIMULATION_EVIDENCE_PREFIX.length),
            );
            if (problem === "wrong-result")
                message.result.checks["synthetic-check"] = false;
            else message.failure.coverage[0].status = "passed";
            lines[index] =
                `${SIMULATION_EVIDENCE_PREFIX}${JSON.stringify(message)}`;
        }
        await writeFile(
            path.join(f.report.directory, "replay-serial.log"),
            `${lines.join("\n")}\n`,
        );
        f.report.serialSha256 = await hashFile(
            path.join(f.report.directory, "replay-serial.log"),
        );
        await writeFile(
            path.join(f.report.directory, "report.json"),
            JSON.stringify(f.report),
        );
        await assert.rejects(
            readRunEvidence(f.report.directory),
            /result evidence|Failure coverage/,
        );
    }
});
