import assert from "node:assert/strict";
import test from "node:test";
import {
    parseNativeProcessMaps,
    nativeMemoryWindow,
    readNativeProcText,
    readNativeMemoryWindows,
} from "./native-core-memory.mjs";
import {
    NATIVE_CORE_CONTEXT_POLICY as POLICY,
    NATIVE_MEMORY_WINDOW as WINDOW,
} from "./native-failure-evidence.mjs";
import { nativeCoreWireFixture } from "./fixtures/native-core-wire.mjs";
import { parseElfCoreNotes } from "./elf-core-notes.mjs";

test("proc maps retain anonymous mappings and clamp saved-register windows to their actual readable extent", () => {
    const fixture = nativeCoreWireFixture(),
        maps = parseNativeProcessMaps(fixture.maps);
    assert.equal(maps[1].name, "[stack]");
    const stack = nativeMemoryWindow(maps[1], fixture.rsp, WINDOW.Stack);
    assert.equal(stack.address, "0x70000080");
    assert.equal(stack.registerOffset, 128);
    assert.equal(stack.requestedBytes, POLICY.stackBytes);
    assert.equal(
        nativeMemoryWindow(maps[0], 0x400000n, WINDOW.Instructions)
            .registerOffset,
        0,
    );
    assert.equal(
        nativeMemoryWindow(maps[0], 0x400fffn, WINDOW.Instructions)
            .requestedBytes,
        33,
    );
    assert.throws(
        () => nativeMemoryWindow(maps[0], fixture.rsp, WINDOW.Stack),
        /escapes/,
    );
    assert.throws(
        () =>
            nativeMemoryWindow(
                { ...maps[0], permissions: "---p" },
                fixture.rip,
                WINDOW.Instructions,
            ),
        /readable/,
    );
    for (const text of [
        "",
        "garbage",
        fixture.maps + fixture.maps,
        "ffffffffffffffff-10000000000000000 r--p 0 00:00 0\n",
        "x".repeat(POLICY.mapsBytes + 1),
    ])
        assert.throws(() => parseNativeProcessMaps(text));
});

test("proc text uses bounded partial reads and closes on oversized input", async () => {
    for (const text of ["bounded", "too much text"]) {
        let closed = false;
        const io = {
            open: async () => ({
                read: async ({ buffer, offset, length, position }) => {
                    assert.equal(typeof position, "bigint");
                    const data = Buffer.from(text).subarray(
                        Number(position),
                        Number(position) + Math.min(2, length),
                    );
                    data.copy(buffer, offset);
                    return { bytesRead: data.length };
                },
                close: async () => {
                    closed = true;
                },
            }),
        };
        const result = readNativeProcText(io, "/synthetic/proc", 8);
        if (text.length <= 8) assert.equal(await result, text);
        else await assert.rejects(result, /ceiling/);
        assert.equal(closed, true);
    }
});

test("memory windows use BigInt positions, retry partial reads and retain short/unreadable gaps", async () => {
    const fixture = nativeCoreWireFixture(),
        notes = parseElfCoreNotes(fixture.raw),
        maps = parseNativeProcessMaps(fixture.maps);
    for (const short of [false, true]) {
        let closed = false;
        const io = {
            open: async (filename) => {
                assert.equal(filename, `/proc/${fixture.pid}/mem`);
                return {
                    read: async ({ buffer, offset, length, position }) => {
                        const mapping =
                            position < 0x70000000n
                                ? { start: 0x400000n, bytes: fixture.code }
                                : { start: 0x70000000n, bytes: fixture.stack };
                        const at = Number(position - mapping.start);
                        const size =
                            short && offset > 5 ? 0 : Math.min(7, length);
                        const bytes = mapping.bytes.subarray(at, at + size);
                        bytes.copy(buffer, offset);
                        return { bytesRead: bytes.length };
                    },
                    close: async () => {
                        closed = true;
                    },
                };
            },
        };
        const windows = await readNativeMemoryWindows(
            io,
            fixture.pid,
            notes,
            maps,
        );
        assert.equal(closed, true);
        assert.equal(windows.stack.complete, !short);
        if (!short) {
            assert.equal(windows.stack.bytes.readBigUInt64LE(128), 0x400110n);
            assert.equal(windows.instructions.bytes[32], 0x89);
        } else assert.match(windows.instructions.error, /Short read/);
    }
    const missing = await readNativeMemoryWindows(
        {
            open: async () => ({
                read: async () => {
                    throw new Error("gone");
                },
                close: async () => {},
            }),
        },
        fixture.pid,
        notes,
        maps,
    );
    assert.equal(missing.stack.complete, false);
    assert.match(missing.stack.error, /gone/);
});
