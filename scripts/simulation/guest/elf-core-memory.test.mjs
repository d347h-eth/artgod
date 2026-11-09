import assert from "node:assert/strict";
import test from "node:test";
import {
    enrichElfCoreMemory,
    ELF_CORE_MEMORY_LIMITS,
} from "./elf-core-memory.mjs";
import { parseElfCoreNotes, readElfCoreLayout } from "./elf-core-notes.mjs";
import { nativeCoreWireFixture } from "./fixtures/native-core-wire.mjs";
import { NATIVE_MEMORY_WINDOW as WINDOW } from "./native-failure-evidence.mjs";

const captures = (fixture) => [
    {
        kind: WINDOW.Instructions,
        address: "0x40005a",
        bytes: fixture.code.subarray(0x5a, 0x5a + 512),
    },
    {
        kind: WINDOW.Stack,
        address: "0x70000080",
        bytes: fixture.stack.subarray(128, 128 + 65536),
    },
];
test("derived cores preserve exact raw notes and original input while adding explicitly sourced memory ranges", () => {
    const fixture = nativeCoreWireFixture({ includeCode: true }),
        before = Buffer.from(fixture.raw);
    const derived = enrichElfCoreMemory(fixture.raw, captures(fixture));
    assert.deepEqual(fixture.raw, before);
    assert.equal(derived.evidence, "derived-core-with-bounded-memory-windows");
    assert.ok(derived.bytes.length < ELF_CORE_MEMORY_LIMITS.derivedBytes);
    const layout = readElfCoreLayout(derived.bytes),
        note = layout.headers.find((item) => item.type === 4);
    assert.deepEqual(
        derived.bytes.subarray(
            Number(note.offset),
            Number(note.offset + note.fileBytes),
        ),
        fixture.notes,
    );
    const { noteOffset: derivedOffset, ...derivedThread } = parseElfCoreNotes(
        derived.bytes,
    ).crashingThread;
    const { noteOffset: rawOffset, ...rawThread } = parseElfCoreNotes(
        fixture.raw,
    ).crashingThread;
    assert.deepEqual(derivedThread, rawThread);
    assert.notEqual(derivedOffset, rawOffset); // PHDR expansion moves the intact NOTE payload.
    const stack = layout.headers.find(
        (item) => item.type === 1 && item.address === 0x70000080n,
    );
    assert.equal(
        derived.bytes.readBigUInt64LE(Number(stack.offset) + 128),
        0x400110n,
    );
    assert.equal(
        derived.provenance.find((item) => item.source === WINDOW.Stack)
            .sizeBytes,
        65536,
    );
});
test("derived data cannot escape raw mappings, overwrite disagreeing kernel bytes, invent a source or exceed caps", () => {
    const fixture = nativeCoreWireFixture({ includeCode: true });
    for (const mutate of [
        (list) => {
            list[0].address = "0x80000000";
        },
        (list) => {
            list[0].bytes = Buffer.from(list[0].bytes);
            list[0].bytes[0] ^= 1;
        },
        (list) => {
            list[0].kind = "invented";
        },
        (list) => {
            list[0].bytes = Buffer.alloc(65537);
        },
        (list) => {
            list.push(list[0]);
        },
    ]) {
        const list = captures(fixture);
        mutate(list);
        assert.throws(() => enrichElfCoreMemory(fixture.raw, list));
    }
    assert.throws(() => enrichElfCoreMemory(fixture.raw, []));
    assert.throws(
        () =>
            enrichElfCoreMemory(fixture.raw.subarray(0, -1), captures(fixture)),
        /incomplete/i,
    );
});
