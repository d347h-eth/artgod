import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, chmod, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pinFile } from "../artifacts.mjs";
import {
    prepareNativeDiagnostics,
    nativeCoreLimitCommand,
    NATIVE_DIAGNOSTIC_ACTOR,
    NATIVE_DIAGNOSTIC_CHECK,
    NATIVE_CORE_POLICY,
    NATIVE_DIAGNOSTIC_PROFILE,
} from "./native-failure-evidence.mjs";
import { ELF_CORE_SIGNAL } from "./elf-core-notes.mjs";
import { SCENARIO_KIND } from "./scenario-contract.mjs";

// Materialize under tmp for the existing run CLI. This descriptor is separate
// from the discovered regression corpus and the mandatory eight-check M0.
export const NATIVE_CORE_PROBE_SCENARIO = Object.freeze({
    version: 1,
    kind: SCENARIO_KIND.NativeDiagnostic,
    qualificationId: "artgod-native-core-probe-v1",
    expectedChecks: Object.freeze([NATIVE_DIAGNOSTIC_CHECK]),
    nativeDiagnostics: Object.freeze({
        profile: NATIVE_DIAGNOSTIC_PROFILE.BoundedCore,
    }),
});

export const NATIVE_CORE_CONTEXT_PROBE_SCENARIO = Object.freeze({
    ...NATIVE_CORE_PROBE_SCENARIO,
    qualificationId: "artgod-native-core-context-probe-v2",
    nativeDiagnostics: Object.freeze({
        profile: NATIVE_DIAGNOSTIC_PROFILE.RegisteredContext,
    }),
});

export const NATIVE_CORE_PROBE = Object.freeze({
    directory: "native-probe",
    binary: "null-write",
    instruction: "0x40007a",
    maximumMs: 10000,
    outputBytes: 8192,
    stackMarker: "0x415254474f444b41",
    stackReturn: "0x400110",
});

/** Synthetic Linux/x86-64 fixture only. Never execute this artifact on the host. */
export function nativeFaultFixture() {
    const bytes = Buffer.alloc(126);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
    bytes.writeUInt16LE(2, 16); // ET_EXEC
    bytes.writeUInt16LE(62, 18); // EM_X86_64
    bytes.writeUInt32LE(1, 20);
    bytes.writeBigUInt64LE(0x400078n, 24);
    bytes.writeBigUInt64LE(64n, 32);
    bytes.writeUInt16LE(64, 52);
    bytes.writeUInt16LE(56, 54);
    bytes.writeUInt16LE(1, 56);
    bytes.writeUInt32LE(1, 64); // One PT_LOAD, readable/executable.
    bytes.writeUInt32LE(5, 68);
    bytes.writeBigUInt64LE(0x400000n, 80);
    bytes.writeBigUInt64LE(0x400000n, 88);
    bytes.writeBigUInt64LE(BigInt(bytes.length), 96);
    bytes.writeBigUInt64LE(BigInt(bytes.length), 104);
    bytes.writeBigUInt64LE(4096n, 112);
    // xor eax,eax; mov DWORD PTR [rax],eax; ud2 (unreachable fail-closed guard).
    bytes.set([0x31, 0xc0, 0x89, 0x00, 0x0f, 0x0b], 120);
    return bytes;
}

/** The opt-in v2 fixture supplies two independently known stack words. The
 * reviewed v1 fault instruction and its RIP stay byte-identical. Never run host-side. */
export function nativeContextFaultFixture() {
    const bytes = Buffer.alloc(0x112);
    nativeFaultFixture().copy(bytes);
    bytes.writeBigUInt64LE(0x400100n, 24);
    bytes.writeBigUInt64LE(BigInt(bytes.length), 96);
    bytes.writeBigUInt64LE(BigInt(bytes.length), 104);
    bytes.set([0x48, 0xb8], 0x100); // movabs rax, marker
    bytes.writeBigUInt64LE(BigInt(NATIVE_CORE_PROBE.stackMarker), 0x102);
    bytes[0x10a] = 0x50; // push rax
    bytes[0x10b] = 0xe8; // call reviewed null-write sequence
    bytes.writeInt32LE(0x78 - 0x110, 0x10c);
    bytes.set([0x0f, 0x0b], 0x110); // unreachable guard; also known return word
    return bytes;
}

/** Require real retained memory bytes, not only successful metadata flags. */
export async function assertNativeProbeContext(
    capture,
    filename,
    pid,
    io = { lstat, readFile },
) {
    assertNativeProbeCapture(capture, filename, pid);
    const collector = capture.collector;
    assert.equal(collector?.complete, true);
    assert.equal(collector.memoryComplete, true);
    assert.equal(collector.notes.process.pid, pid);
    const readWindow = async (kind) => {
        const item = collector.windows[kind];
        assert.equal(item.complete, true);
        const expectedFile = `native-core/${kind}.bin`;
        assert.equal(item.file, expectedFile);
        const file = path.join("/workbench/output", expectedFile);
        const metadata = await io.lstat(file);
        assert.equal(metadata.isFile(), true);
        assert.equal(metadata.size, item.sizeBytes);
        assert.ok(item.sizeBytes > 0 && item.sizeBytes <= 65536);
        const bytes = await io.readFile(file);
        assert.equal(bytes.length, item.sizeBytes);
        assert.equal(
            createHash("sha256").update(bytes).digest("hex"),
            item.sha256,
        );
        return { item, bytes };
    };
    const stack = await readWindow("stack"),
        code = await readWindow("instructions");
    assert.equal(
        stack.bytes.readBigUInt64LE(stack.item.registerOffset),
        BigInt(NATIVE_CORE_PROBE.stackReturn),
    );
    assert.equal(
        stack.bytes.readBigUInt64LE(stack.item.registerOffset + 8),
        BigInt(NATIVE_CORE_PROBE.stackMarker),
    );
    assert.equal(
        code.bytes
            .subarray(code.item.registerOffset, code.item.registerOffset + 4)
            .toString("hex"),
        "89000f0b",
    );
    assert.equal(collector.derived?.rawSha256, capture.cores[0].sha256);
    return {
        stackReturn: NATIVE_CORE_PROBE.stackReturn,
        stackMarker: NATIVE_CORE_PROBE.stackMarker,
        instructionBytes: "89000f0b",
    };
}

/** Reuse the artifact pin owner, and reject symlinks before its ordinary file stat. */
export async function assertFaultFixture(filename, expectedBytes) {
    const metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.size !== expectedBytes.length)
        throw new Error(
            "The staged native fixture is not the expected regular file",
        );
    const actual = await pinFile(filename);
    if (
        actual.sha256 !==
        createHash("sha256").update(expectedBytes).digest("hex")
    )
        throw new Error(
            "The staged native fixture readback differs from its source bytes",
        );
    return actual;
}

export function assertNativeProbeCapture(capture, filename, pid) {
    assert.equal(
        capture.missing,
        false,
        "The synthetic fault must produce a core",
    );
    assert.equal(capture.error, undefined, "Core inventory must be complete");
    assert.equal(
        capture.artifactError,
        undefined,
        "The effective policy receipt must be retained",
    );
    assert.equal(
        capture.cores.length,
        1,
        "Exactly one bounded synthetic core is required",
    );
    const core = capture.cores[0];
    assert.equal(core.pid, pid);
    assert.equal(core.signalNumber, ELF_CORE_SIGNAL.SegmentationFault);
    assert.equal(core.capReached, false);
    assert.equal(
        core.notesComplete,
        true,
        "Signal, registers and file mappings must all be present",
    );
    assert.equal(core.signal.number, ELF_CORE_SIGNAL.SegmentationFault);
    assert.equal(core.signal.code, ELF_CORE_SIGNAL.MapError);
    assert.equal(core.signal.faultAddress, "0x0");
    assert.equal(core.crashingThread.tid, pid);
    assert.equal(
        core.crashingThread.registers.rip,
        NATIVE_CORE_PROBE.instruction,
    );
    assert.equal(core.executable, true);
    assert.equal(
        core.loadSegmentsComplete,
        true,
        "The synthetic core must not be truncated",
    );
    assert.equal(core.fileMapping.file, filename);
    assert.equal(core.fileMapping.instructionFileOffset, "0x7a");
    assert.ok(core.sizeBytes > 0 && core.sizeBytes < NATIVE_CORE_POLICY.bytes);
}

/** A separate capture qualification; it does not replace the eight M0 checks. */
export async function runNativeCoreProbe(scenario, { root, output }) {
    await mkdir(output, { recursive: true });
    const diagnostics = await prepareNativeDiagnostics({
        settings: scenario.nativeDiagnostics,
        root,
        output,
        actorId: NATIVE_DIAGNOSTIC_ACTOR.Probe,
    });
    const directory = path.join(output, NATIVE_CORE_PROBE.directory);
    await mkdir(directory, { mode: 0o700 });
    const filename = path.join(directory, NATIVE_CORE_PROBE.binary);
    const contextProfile =
        scenario.nativeDiagnostics.profile ===
        NATIVE_DIAGNOSTIC_PROFILE.RegisteredContext;
    const expectedBytes = contextProfile
        ? nativeContextFaultFixture()
        : nativeFaultFixture();
    await writeFile(filename, expectedBytes, {
        flag: "wx",
        mode: 0o700,
    });
    await chmod(filename, 0o700);
    const fixturePin = await assertFaultFixture(filename, expectedBytes);
    // Fixed private guest paths and a quoted positional executable. The receipt
    // observes inherited limits immediately before exec of the faulting fixture.
    const script =
        'set -e\n/bin/busybox cat /proc/self/limits > /workbench/output/native-probe/limits\n/bin/busybox cat /proc/self/coredump_filter > /workbench/output/native-probe/filter\nexec "$1"';
    const command = nativeCoreLimitCommand("/bin/busybox", [
        "sh",
        "-c",
        script,
        "native-core-probe",
        filename,
    ]);
    const child = spawn(command.file, command.args, {
        cwd: directory,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let bytes = 0,
        timedOut = false,
        outputLimit = false;
    const stdout = [],
        stderr = [];
    let exited;
    let timer;
    const complete = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
        const count = (chunks) => (chunk) => {
            bytes += chunk.length;
            if (bytes <= NATIVE_CORE_PROBE.outputBytes) chunks.push(chunk);
            if (bytes > NATIVE_CORE_PROBE.outputBytes) {
                outputLimit = true;
                child.kill("SIGKILL");
            }
        };
        child.stdout.on("data", count(stdout));
        child.stderr.on("data", count(stderr));
        timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, NATIVE_CORE_PROBE.maximumMs);
    });
    let capture, failure, afterFixturePin;
    try {
        if (!Number.isSafeInteger(child.pid)) await complete;
        await diagnostics.track(
            { id: NATIVE_DIAGNOSTIC_ACTOR.Probe, filename, generation: 0 },
            child,
        );
        exited = await complete;
        assert.equal(timedOut, false);
        assert.equal(outputLimit, false);
        assert.equal(exited.code, null);
        assert.equal(exited.signal, "SIGSEGV");
        afterFixturePin = await assertFaultFixture(filename, expectedBytes);
        assert.deepEqual(
            afterFixturePin,
            fixturePin,
            "The executed fixture pin must remain unchanged",
        );
        await diagnostics.verifyProbeReceipt({
            limits: await readFile(path.join(directory, "limits"), "utf8"),
            filter: await readFile(path.join(directory, "filter"), "utf8"),
            pid: child.pid,
            filename,
        });
        capture = await diagnostics.capture();
        assertNativeProbeCapture(capture, filename, child.pid);
        if (contextProfile)
            await assertNativeProbeContext(capture, filename, child.pid);
        return {
            checks: { [NATIVE_DIAGNOSTIC_CHECK]: true },
            evidence: {
                nativeDiagnostics: capture,
                nativeProbe: { fixturePin, afterFixturePin },
            },
        };
    } catch (error) {
        failure = error;
        error.simulation = {
            ...(error.simulation ?? {}),
            checks: { [NATIVE_DIAGNOSTIC_CHECK]: false },
            nativeDiagnostics: capture ?? (await diagnostics.capture()),
            nativeProbeProcess: {
                command,
                fixturePin,
                afterFixturePin,
                exited,
                timedOut,
                outputLimit,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
            },
        };
        throw error;
    } finally {
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
        await writeFile(
            path.join(directory, "process.json"),
            `${JSON.stringify({ command, fixturePin, afterFixturePin, exited, timedOut, outputLimit, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }, null, 2)}\n`,
        ).catch((error) => {
            if (failure)
                failure.simulation.nativeProbeProcess.artifactError =
                    error.message;
            else
                throw Object.assign(error, {
                    simulation: {
                        checks: { [NATIVE_DIAGNOSTIC_CHECK]: false },
                        nativeDiagnostics: capture,
                    },
                });
        });
    }
}
