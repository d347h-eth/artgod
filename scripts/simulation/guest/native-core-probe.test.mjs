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
