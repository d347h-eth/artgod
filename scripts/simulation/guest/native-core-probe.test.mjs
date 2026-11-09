import assert from "node:assert/strict";
import test from "node:test";
import { writeFile, symlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createArtifactRunDirectory } from "../artifacts.mjs";
import {
    nativeFaultFixture,
    assertFaultFixture,
    assertNativeProbeCapture,
    NATIVE_CORE_PROBE,
} from "./native-core-probe.mjs";
import { NATIVE_CORE_POLICY } from "./native-failure-evidence.mjs";

test("the synthetic fixture is a fixed x86-64 executable with the reviewed null write at its declared RIP", () => {
    const bytes = nativeFaultFixture();
    assert.equal(bytes.subarray(0, 7).toString("hex"), "7f454c46020101");
    assert.equal(bytes.readUInt16LE(18), 62);
    assert.equal(
        bytes.readBigUInt64LE(24) + 2n,
        BigInt(NATIVE_CORE_PROBE.instruction),
    );
    assert.equal(bytes.readUInt32LE(64), 1);
    assert.equal(bytes.readBigUInt64LE(80), 0x400000n);
    assert.equal(bytes.readBigUInt64LE(96), BigInt(bytes.length));
    assert.equal(bytes.subarray(120).toString("hex"), "31c089000f0b");
});

test("fixture admission reads back exact regular bytes and refuses changed or symbolic input without executing it", async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const directory = await createArtifactRunDirectory(
        path.join(root, "tmp/simulation-native-core-tests"),
        "fixture-",
    );
    const filename = path.join(directory, "fixture"),
        bytes = nativeFaultFixture();
    await writeFile(filename, bytes, { mode: 0o600 });
    const pin = await assertFaultFixture(filename, bytes);
    assert.equal(pin.sizeBytes, 126);
    const link = path.join(directory, "link");
    await symlink("fixture", link);
    await assert.rejects(assertFaultFixture(link, bytes), /regular file/);
    const changed = Buffer.from(bytes);
    changed[122] = 0x90;
    await writeFile(filename, changed);
    await assert.rejects(
        assertFaultFixture(filename, bytes),
        /readback differs/,
    );
});

test("capture qualification rejects incomplete notes, user signals, wrong instruction/mapping, missing cores and cap saturation", () => {
    const filename = "/workbench/output/native-probe/null-write",
        pid = 404;
    const valid = {
        missing: false,
        cores: [
            {
                pid,
                signalNumber: 11,
                capReached: false,
                notesComplete: true,
                signal: { number: 11, code: 1, faultAddress: "0x0" },
                crashingThread: { tid: pid, registers: { rip: "0x40007a" } },
                executable: true,
                loadSegmentsComplete: true,
                fileMapping: { file: filename, instructionFileOffset: "0x7a" },
                sizeBytes: 16384,
            },
        ],
    };
    assertNativeProbeCapture(valid, filename, pid);
    for (const mutate of [
        (value) => {
            value.missing = true;
        },
        (value) => {
            value.cores = [];
        },
        (value) => {
            value.cores[0].notesComplete = false;
        },
        (value) => {
            value.cores[0].signal.code = -6;
        },
        (value) => {
            value.cores[0].signal.faultAddress = "0x1";
        },
        (value) => {
            value.cores[0].crashingThread.registers.rip = "0x400078";
        },
        (value) => {
            value.cores[0].fileMapping.file = "/foreign";
        },
        (value) => {
            value.cores[0].fileMapping.instructionFileOffset = "0x0";
        },
        (value) => {
            value.cores[0].executable = false;
        },
        (value) => {
            value.cores[0].capReached = true;
        },
        (value) => {
            value.cores[0].loadSegmentsComplete = false;
        },
        (value) => {
            value.artifactError = "write failed";
        },
        (value) => {
            value.cores[0].sizeBytes = NATIVE_CORE_POLICY.bytes;
        },
    ]) {
        const value = structuredClone(valid);
        mutate(value);
        assert.throws(() => assertNativeProbeCapture(value, filename, pid));
    }
});

test("the context fixture preserves the old fault bytes and independently pushes a reviewed return address and marker", async () => {
    const { nativeContextFaultFixture, NATIVE_CORE_CONTEXT_PROBE_SCENARIO } =
        await import("./native-core-probe.mjs");
    const bytes = nativeContextFaultFixture();
    assert.equal(bytes.readBigUInt64LE(24), 0x400100n);
    assert.equal(bytes.subarray(120, 126).toString("hex"), "31c089000f0b");
    assert.equal(bytes.subarray(0x100, 0x102).toString("hex"), "48b8");
    assert.equal(bytes.readBigUInt64LE(0x102), 0x415254474f444b41n);
    assert.equal(bytes.subarray(0x10a, 0x10c).toString("hex"), "50e8");
    assert.equal(0x110 + bytes.readInt32LE(0x10c), 0x78);
    assert.equal(bytes.subarray(0x110).toString("hex"), "0f0b");
    assert.equal(NATIVE_CORE_CONTEXT_PROBE_SCENARIO.expectedChecks.length, 1);
    assert.notEqual(
        NATIVE_CORE_CONTEXT_PROBE_SCENARIO.nativeDiagnostics.profile,
        "bounded-core-v1",
    );
});

test("context qualification requires independently known retained stack/code bytes and their exact artifact pins", async () => {
    const { assertNativeProbeContext } =
        await import("./native-core-probe.mjs");
    const { nativeCoreWireFixture } =
        await import("./fixtures/native-core-wire.mjs");
    const { parseElfCoreNotes } = await import("./elf-core-notes.mjs");
    const { createHash } = await import("node:crypto");
    const fixture = nativeCoreWireFixture(),
        notes = parseElfCoreNotes(fixture.raw);
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const windows = {
        stack: fixture.stack.subarray(128, 128 + 65536),
        instructions: fixture.code.subarray(0x5a, 0x5a + 512),
    };
    const valid = {
        missing: false,
        cores: [
            {
                ...notes,
                pid: fixture.pid,
                signalNumber: 11,
                capReached: false,
                sizeBytes: fixture.raw.length,
                sha256: digest(fixture.raw),
            },
        ],
        collector: {
            complete: true,
            memoryComplete: true,
            notes: { process: { pid: fixture.pid } },
            derived: { rawSha256: digest(fixture.raw) },
            windows: Object.fromEntries(
                Object.entries(windows).map(([kind, bytes]) => [
                    kind,
                    {
                        complete: true,
                        file: `native-core/${kind}.bin`,
                        sizeBytes: bytes.length,
                        sha256: digest(bytes),
                        registerOffset: kind === "stack" ? 128 : 32,
                    },
                ]),
            ),
        },
    };
    const makeIo = (buffers) => ({
        lstat: async (filename) => ({
            isFile: () => true,
            size: buffers[path.basename(filename, ".bin")].length,
        }),
        readFile: async (filename) => buffers[path.basename(filename, ".bin")],
    });
    await assertNativeProbeContext(
        valid,
        fixture.filename,
        fixture.pid,
        makeIo(windows),
    );
    for (const mutate of [
        (value) => {
            value.collector.memoryComplete = false;
        },
        (value) => {
            value.collector.windows.stack.sha256 = "a".repeat(64);
        },
        (value) => {
            value.collector.derived.rawSha256 = "b".repeat(64);
        },
        (value) => {
            value.collector.windows.instructions.file = "../outside";
        },
    ]) {
        const copy = structuredClone(valid);
        mutate(copy);
        await assert.rejects(
            assertNativeProbeContext(
                copy,
                fixture.filename,
                fixture.pid,
                makeIo(windows),
            ),
        );
    }
    for (const kind of ["stack", "instructions"]) {
        const copy = structuredClone(valid),
            buffers = { ...windows, [kind]: Buffer.from(windows[kind]) };
        buffers[kind][copy.collector.windows[kind].registerOffset] ^= 1;
        copy.collector.windows[kind].sha256 = digest(buffers[kind]); // A valid pin cannot replace the independent known answer.
        await assert.rejects(
            assertNativeProbeContext(
                copy,
                fixture.filename,
                fixture.pid,
                makeIo(buffers),
            ),
        );
    }
});
