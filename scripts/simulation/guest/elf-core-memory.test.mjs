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

// Add explicit wire segments without allocating their declared virtual memory.
function appendWireLoads(raw, entries) {
    const original = raw.readUInt16LE(56),
        oldEnd = 64 + original * 56;
    const delta = entries.length * 56,
        tail = raw.length + delta;
    const result = Buffer.alloc(
        tail + entries.reduce((sum, entry) => sum + entry.bytes.length, 0),
    );
    raw.copy(result, 0, 0, oldEnd);
    raw.copy(result, oldEnd + delta, oldEnd);
    result.writeUInt16LE(original + entries.length, 56);
    for (let index = 0; index < original; index++) {
        const at = 64 + index * 56;
        result.writeBigUInt64LE(
            raw.readBigUInt64LE(at + 8) + BigInt(delta),
            at + 8,
        );
    }
    let cursor = tail;
    for (const [index, entry] of entries.entries()) {
        const at = 64 + (original + index) * 56;
        result.writeUInt32LE(1, at);
        result.writeUInt32LE(4, at + 4);
        result.writeBigUInt64LE(BigInt(cursor), at + 8);
        result.writeBigUInt64LE(entry.address, at + 16);
        result.writeBigUInt64LE(BigInt(entry.bytes.length), at + 32);
        result.writeBigUInt64LE(
            entry.memoryBytes ?? BigInt(entry.bytes.length),
            at + 40,
        );
        result.writeBigUInt64LE(4096n, at + 48);
        entry.bytes.copy(result, cursor);
        cursor += entry.bytes.length;
    }
    return result;
}

test("every derived LOAD preserves page congruence, virtual extents, actual data and provenance", () => {
    const fixture = nativeCoreWireFixture({ includeCode: true });
    const windows = captures(fixture),
        derived = enrichElfCoreMemory(fixture.raw, windows);
    const layout = readElfCoreLayout(derived.bytes),
        loads = layout.headers.filter((header) => header.type === 1);
    assert.deepEqual(
        loads.map((header) => [header.address, header.memoryBytes]),
        [
            [0x400000n, 0x5an],
            [0x40005an, 512n],
            [0x40025an, 0xda6n],
            [0x70000000n, 128n],
            [0x70000080n, 65536n],
            [0x70010080n, 0xff80n],
        ],
    );
    for (const header of loads) {
        assert.equal(header.alignment, 4096n);
        assert.equal(header.offset % 4096n, header.address % 4096n);
        assert.ok(
            header.offset + header.fileBytes <= BigInt(derived.bytes.length),
        );
    }
    const occupied = Buffer.alloc(derived.bytes.length);
    occupied.fill(1, 0, 64 + layout.headers.length * 56);
    for (const header of layout.headers)
        occupied.fill(
            1,
            Number(header.offset),
            Number(header.offset + header.fileBytes),
        );
    for (let index = 0; index < occupied.length; index++)
        if (!occupied[index])
            assert.equal(
                derived.bytes[index],
                0,
                "File padding cannot fabricate mapped bytes",
            );
    for (const item of derived.provenance) {
        const source = item.source.startsWith("raw-")
            ? fixture.raw
            : windows.find((window) => window.kind === item.source).bytes;
        assert.deepEqual(
            derived.bytes.subarray(
                item.outputOffset,
                item.outputOffset + item.sizeBytes,
            ),
            source.subarray(
                item.sourceOffset,
                item.sourceOffset + item.sizeBytes,
            ),
        );
    }
});

test("thousands of zero-data LOADs preserve omitted virtual ranges without allocating their declared memory or repeated padding", () => {
    const fixture = nativeCoreWireFixture();
    const omitted = Array.from({ length: 2000 }, (_, index) => ({
        address: 0x100000000n + BigInt(index) * 0x1001n,
        bytes: Buffer.alloc(0),
        memoryBytes: 1n,
    }));
    omitted.push({
        address: 0x200000000n,
        bytes: Buffer.alloc(0),
        memoryBytes: 0x100000000n,
    });
    const raw = appendWireLoads(fixture.raw, omitted),
        before = Buffer.from(raw);
    const derived = enrichElfCoreMemory(raw, captures(fixture));
    assert.deepEqual(raw, before);
    const loads = readElfCoreLayout(derived.bytes).headers.filter(
        (header) => header.type === 1 && header.address >= 0x100000000n,
    );
    assert.equal(loads.length, omitted.length);
    for (const [index, header] of loads.entries()) {
        assert.equal(header.fileBytes, 0n);
        assert.equal(header.memoryBytes, omitted[index].memoryBytes);
        assert.equal(header.offset % 4096n, header.address % 4096n);
    }
    assert.ok(
        derived.bytes.length < raw.length + 65536 + 512 + 4 * 4096,
        "Zero-data ranges cannot consume one padding page each",
    );
});

test("alignment padding stays within the fixed derived-artifact byte cap", () => {
    const fixture = nativeCoreWireFixture(),
        bytes = Buffer.alloc(8193, 0x5a);
    const entries = Array.from({ length: 3600 }, (_, index) => ({
        address: 0x100000000n + BigInt(index) * 0x10000n,
        bytes,
    }));
    const raw = appendWireLoads(fixture.raw, entries);
    assert.throws(
        () => enrichElfCoreMemory(raw, captures(fixture)),
        /byte limit exceeded/,
    );
});
