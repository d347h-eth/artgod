import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    stat,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    QUALIFICATION_PROTOCOL,
    assertStandaloneImage,
    executeCommand,
    preflight,
    qemuArguments,
    qualify,
    validateManifest,
} from "./qemu-replay.mjs";
import { QUALIFICATION_CHECKS } from "./qualification-protocol.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TEST_ROOT = path.join(ROOT, "tmp", "simulation-qemu-tests");
const okay = (stdout = "") => ({
    code: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
});
const image = () => ({ format: "qcow2", "virtual-size": 1048576 });

async function fixture() {
    await mkdir(TEST_ROOT, { recursive: true });
    const directory = await mkdtemp(path.join(TEST_ROOT, "run-"));
    const pins = {};
    for (const name of [
        "qemu",
        "qemuImg",
        "firmware",
        "kernel",
        "guest",
        "scenario",
    ]) {
        const data = Buffer.from(`synthetic ${name} fixture; never executed`);
        const file = path.join(directory, name);
        await writeFile(file, data);
        pins[name] = {
            path: file,
            sizeBytes: data.length,
            sha256: createHash("sha256").update(data).digest("hex"),
            ...(["qemu", "qemuImg"].includes(name)
                ? { version: `${name} fixture version 1` }
                : {}),
        };
    }
    const manifest = {
        version: 1,
        sourceSha: "a".repeat(40),
        qualificationId: "test-substrate",
        expectedChecks: ["synthetic-test"],
        machine: "pc-i440fx-9.2",
        epoch: "2026-11-08T00:00:00Z",
        timeoutSeconds: 1,
        ...pins,
    };
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const outputRoot = path.join(directory, "artifacts");
    const messages = [
        {
            version: 1,
            qualificationId: manifest.qualificationId,
            event: "ready",
        },
        {
            version: 1,
            qualificationId: manifest.qualificationId,
            event: "complete",
            status: "passed",
            checks: { "synthetic-test": true },
        },
    ];
    const serial = () =>
        messages
            .map(
                (message) =>
                    `${QUALIFICATION_PROTOCOL}${JSON.stringify(message)}\n`,
            )
            .join("");
    const calls = [];
    const execute = async (file, args, options = {}) => {
        calls.push({ file, args, options });
        if (args[0] === "--version")
            return okay(
                `${file === pins.qemu.path ? pins.qemu.version : pins.qemuImg.version}\n`,
            );
        if (args[0] === "-machine")
            return okay("Supported machines are:\npc-i440fx-9.2 Standard PC\n");
        if (args[0] === "info") return okay(JSON.stringify(image()));
        if (args[0] === "create") {
            await writeFile(args.at(-1), "synthetic overlay");
            return okay();
        }
        const clock = args[args.indexOf("-icount") + 1];
        if (clock.includes("rr=record"))
            await writeFile(
                clock.split("rrfile=")[1],
                "synthetic replay events",
            );
        await writeFile(options.stdoutPath, serial());
        await writeFile(options.stderrPath, "synthetic emulator diagnostic\n");
        return okay();
    };
    return {
        directory,
        manifest,
        manifestPath,
        outputRoot,
        execute,
        calls,
        messages,
        serial,
    };
}

test("manifest rejects unknown options, unversioned machine, invalid epoch and missing pins", async () => {
    const f = await fixture();
    assert.equal(
        validateManifest(f.manifest, f.manifestPath).kernel.path,
        f.manifest.kernel.path,
    );
    for (const change of [
        { extraArgs: [] },
        { machine: "pc" },
        { epoch: "2026-02-30T00:00:00Z" },
        { expectedChecks: [] },
        { timeoutSeconds: 0 },
    ])
        assert.throws(() =>
            validateManifest({ ...f.manifest, ...change }, f.manifestPath),
        );
    const { firmware, ...missing } = f.manifest;
    assert.throws(
        () => validateManifest(missing, f.manifestPath),
        /requires exactly/,
    );
    assert.throws(
        () =>
            validateManifest(
                { ...f.manifest, guest: { ...f.manifest.guest, extra: true } },
                f.manifestPath,
            ),
        /requires exactly/,
    );
});

test("standalone image rejects backing, external data, encryption and dirty/corrupt state", () => {
    assertStandaloneImage(image());
    for (const bad of [
        { ...image(), format: "raw" },
        { ...image(), "backing-filename": "base" },
        {
            ...image(),
            "format-specific": { data: { "data-file": "external" } },
        },
        {
            ...image(),
            "format-specific": { data: { encrypt: { format: "luks" } } },
        },
        { ...image(), encrypted: true },
        { ...image(), "dirty-flag": true },
        { ...image(), corrupt: true },
    ])
        assert.throws(() => assertStandaloneImage(bad));
});

test("preflight is read-only and checks pinned versions plus available machine", async () => {
    const f = await fixture();
    await preflight(f.manifestPath, { execute: f.execute });
    assert.equal(f.calls.length, 4);
    assert.ok(
        !f.calls.some(
            ({ args }) => args.includes("create") || args.includes("-icount"),
        ),
    );
    assert.ok(!(await readdir(f.directory)).includes("artifacts"));
    await assert.rejects(
        preflight(f.manifestPath, {
            execute: async () => okay("wrong version"),
        }),
        /version output/,
    );
    await assert.rejects(
        preflight(f.manifestPath, {
            execute: async (file, args, options) =>
                args[0] === "-machine"
                    ? okay("pc alias\n")
                    : f.execute(file, args, options),
        }),
        /does not provide/,
    );
});

test("changed pinned inputs fail admission before any execution or output creation", async () => {
    const f = await fixture();
    await writeFile(f.manifest.kernel.path, "changed kernel");
    await assert.rejects(qualify(f.manifestPath, f), /Pinned kernel/);
    assert.equal(f.calls.length, 0);
    assert.ok(!(await readdir(f.directory)).includes("artifacts"));
});

test("VM arguments enclose all devices, use fixed CPU/time, replay every disk and disable networking", async () => {
    const f = await fixture();
    const args = qemuArguments(
        f.manifest,
        "/fixture/disk,one.qcow2",
        "/fixture/event,one.bin",
        "record",
    );
    assert.equal(args[args.indexOf("-smp") + 1], "1");
    assert.equal(args[args.indexOf("-accel") + 1], "tcg,thread=single");
    assert.equal(args[args.indexOf("-cpu") + 1], "Nehalem");
    assert.equal(args[args.indexOf("-nic") + 1], "none");
    const kernel = args[args.indexOf("-append") + 1].split(" ");
    for (const parameter of [
        "root=/dev/vda",
        "rw",
        "console=ttyS0",
        "init=/workbench/init",
        "panic=1",
    ])
        assert.ok(kernel.includes(parameter));
    assert.ok(
        !args.some((arg) =>
            /virtfs|fsdev|netdev|hostfwd|kvm|clock=host/.test(arg),
        ),
    );
    const drives = args.flatMap((arg, index) =>
        arg === "-drive" ? [args[index + 1]] : [],
    );
    assert.deepEqual(drives, [
        "file=/fixture/disk,,one.qcow2,format=qcow2,if=none,id=image",
        "driver=blkreplay,if=none,image=image,id=replay-disk",
        `file=${f.manifest.scenario.path.replaceAll(",", ",,")},format=raw,if=none,readonly=on,id=scenario`,
        "driver=blkreplay,if=none,image=scenario,id=scenario-replay,readonly=on",
    ]);
    assert.ok(args.includes("virtio-blk-pci,drive=replay-disk,ioeventfd=off"));
    assert.ok(
        args.includes("virtio-blk-pci,drive=scenario-replay,ioeventfd=off"),
    );
    assert.equal(
        args[args.indexOf("-icount") + 1],
        "shift=0,align=off,sleep=on,rr=record,rrfile=/fixture/event,,one.bin",
    );
    assert.ok(
        args[args.indexOf("-icount") + 1].endsWith(
            "rrfile=/fixture/event,,one.bin",
        ),
    );
});

test("qualification keeps distinct overlays and records narrow evidence with exact raw serial parity", async () => {
    const f = await fixture();
    const report = await qualify(f.manifestPath, f);
    assert.equal(report.status, "passed");
    assert.equal(report.engineReplayStatus, "passed");
    assert.equal(report.propertyStatus, "passed");
    assert.equal(report.substrateQualificationStatus, "not-run");
    assert.equal(report.evidence, "whole-machine-record-replay");
    assert.match(report.limitations.join(" "), /No claim.*ArtGod correctness/);
    assert.deepEqual(
        f.calls
            .filter(({ args }) => args[0] === "create")
            .map(({ args }) => path.basename(args.at(-1))),
        ["record.qcow2", "replay.qcow2"],
    );
    assert.equal(
        JSON.parse(
            await readFile(path.join(report.directory, "report.json"), "utf8"),
        ).status,
        "passed",
    );
    assert.ok((await stat(path.join(report.directory, "replay.bin"))).size > 0);
});

test("exit zero cannot pass without complete, unique and correctly identified guest protocol", async () => {
    const variants = [
        (f) => f.messages.splice(1),
        (f) => f.messages.push(f.messages[1]),
        (f) => f.messages.unshift(f.messages[1]),
        (f) => {
            f.messages[0].qualificationId = "wrong";
        },
        (f) => {
            f.messages[1].checks = {};
        },
        (f) => {
            f.messages[1].checks["synthetic-test"] = false;
        },
        (f) => {
            f.messages[1].unexpected = true;
        },
    ];
    for (const change of variants) {
        const f = await fixture();
        change(f);
        await assert.rejects(
            qualify(f.manifestPath, f),
            /protocol|Guest checks|disagrees|booleans/,
        );
    }
});

test("a completed product failure is replayed and preserved independently of engine replay success", async () => {
    const f = await fixture();
    f.messages[1].status = "failed";
    f.messages[1].checks["synthetic-test"] = false;
    const report = await qualify(f.manifestPath, f);
    assert.equal(
        f.calls.filter(({ args }) => args.includes("-icount")).length,
        2,
    );
    assert.equal(report.engineReplayStatus, "passed");
    assert.equal(report.propertyStatus, "failed");
    assert.equal(report.status, "failed");
    assert.equal(report.substrateQualificationStatus, "not-run");
    assert.deepEqual(report.guestReportedChecks, { "synthetic-test": false });
    assert.ok((await stat(path.join(report.directory, "replay.bin"))).size > 0);
});

test("the substrate qualification claim requires all six owned checks to pass", async () => {
    for (const pass of [true, false]) {
        const f = await fixture();
        f.manifest.expectedChecks = [...QUALIFICATION_CHECKS];
        f.messages[1].checks = Object.fromEntries(
            QUALIFICATION_CHECKS.map((check) => [check, true]),
        );
        f.messages[1].checks[QUALIFICATION_CHECKS[0]] = pass;
        f.messages[1].status = pass ? "passed" : "failed";
        await writeFile(f.manifestPath, JSON.stringify(f.manifest));
        const report = await qualify(f.manifestPath, f);
        assert.equal(report.engineReplayStatus, "passed");
        assert.equal(
            report.substrateQualificationStatus,
            pass ? "passed" : "failed",
        );
        assert.equal(report.status, pass ? "passed" : "failed");
    }
});

test("empty serial, empty replay log, mismatched serial, failed child and timeout cannot pass", async () => {
    for (const problem of [
        "serial",
        "replay-log",
        "parity",
        "exit",
        "timeout",
    ]) {
        const f = await fixture();
        const execute = async (file, args, options) => {
            const result = await f.execute(file, args, options);
            if (!args.includes("-icount")) return result;
            if (problem === "exit") return { ...result, code: 2 };
            if (problem === "timeout") return { ...result, timedOut: true };
            if (problem === "serial") await writeFile(options.stdoutPath, "");
            if (problem === "replay-log")
                await writeFile(
                    args[args.indexOf("-icount") + 1].split("rrfile=")[1],
                    "",
                );
            if (
                problem === "parity" &&
                args.some((arg) => arg.includes("rr=replay"))
            )
                await writeFile(
                    options.stdoutPath,
                    `changed ordinary log\n${f.serial()}`,
                );
            return result;
        };
        await assert.rejects(
            qualify(f.manifestPath, { ...f, execute }),
            /empty|differ|failed/,
        );
    }
});

test("pins are rechecked after recording and a changed manifest cannot start replay", async () => {
    const f = await fixture();
    const execute = async (file, args, options) => {
        const result = await f.execute(file, args, options);
        if (args.some((arg) => arg.includes("rr=record")))
            await writeFile(f.manifestPath, "{}");
        return result;
    };
    await assert.rejects(
        qualify(f.manifestPath, { ...f, execute }),
        /Manifest changed/,
    );
    assert.equal(
        f.calls.filter(({ args }) =>
            args.some((arg) => arg.includes("rr=replay")),
        ).length,
        0,
    );
});

test("output roots outside worktree tmp are rejected without creating them", async () => {
    const f = await fixture();
    await assert.rejects(
        qualify(f.manifestPath, {
            ...f,
            outputRoot: path.join(ROOT, "forbidden-output"),
        }),
        /worktree tmp/,
    );
    await assert.rejects(stat(path.join(ROOT, "forbidden-output")), {
        code: "ENOENT",
    });
});

test("real executor captures a nonzero harmless fixture and kills a hung fixture at its deadline", async () => {
    const failed = await executeCommand(
        process.execPath,
        ["-e", "process.stderr.write('fixture failed'); process.exit(3)"],
        { timeoutMs: 3000 },
    );
    assert.equal(failed.code, 3);
    assert.equal(failed.stderr, "fixture failed");
    const hung = await executeCommand(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { timeoutMs: 50 },
    );
    assert.equal(hung.timedOut, true);
    assert.notEqual(hung.code, 0);
});
