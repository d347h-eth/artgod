import assert from "node:assert/strict";
import test from "node:test";
import { ELF_CORE_LIMITS, parseElfCoreNotes } from "./elf-core-notes.mjs";

// These byte fixtures deliberately assert the Linux ELF64/x86-64 wire ABI.
// Their header/note identifiers and offsets are independent of parser constants.
// Linux v6.6 elfcore.h/user_64.h/binfmt_elf.c establish 336-byte PRSTATUS,
// registers at 112, RIP at 240, RSP at 264, and dump_task/current first.
const align4 = (size) => Math.ceil(size / 4) * 4;
const U64_MAX = (1n << 64n) - 1n;
const RIP = 0x400120n;
const RSP = 0x7fffffff0008n;
const LEADER = 303;
const CRASHING_TID = 707;

function note(type, description, owner = Buffer.from("CORE\0")) {
    const bytes = Buffer.alloc(
        12 + align4(owner.length) + align4(description.length),
    );
    bytes.writeUInt32LE(owner.length, 0);
    bytes.writeUInt32LE(description.length, 4);
    bytes.writeUInt32LE(type, 8);
    owner.copy(bytes, 12);
    description.copy(bytes, 12 + align4(owner.length));
    return bytes;
}

function thread({ tid = CRASHING_TID, rip = RIP, rsp = RSP } = {}) {
    const data = Buffer.alloc(336);
    data.writeInt32LE(11, 0); // elf_siginfo: signo, code, errno (not siginfo_t).
    data.writeInt32LE(77, 4);
    data.writeInt32LE(88, 8);
    data.writeInt16LE(11, 12);
    data.writeInt32LE(tid, 32);
    data.writeInt32LE(LEADER, 36);
    for (let index = 0; index < 27; index++)
        data.writeBigUInt64LE(
            0x20000000000001n + BigInt(index),
            112 + index * 8,
        );
    data.writeBigUInt64LE(rip, 240);
    data.writeBigUInt64LE(rsp, 264);
    return data;
}

function processInfo() {
    const data = Buffer.alloc(136);
    data.writeInt32LE(LEADER, 24);
    Buffer.from("fixture\0").copy(data, 40);
    return data;
}

function signal({
    code = 1,
    errno = 7,
    address = 0n,
    senderPid = 505,
    senderUid = 606,
} = {}) {
    const data = Buffer.alloc(128);
    data.writeInt32LE(11, 0);
    data.writeInt32LE(errno, 4);
    data.writeInt32LE(code, 8);
    if (code > 0) data.writeBigUInt64LE(address, 16);
    else {
        data.writeInt32LE(senderPid, 16);
        data.writeUInt32LE(senderUid, 20);
    }
    return data;
}

function mappedFiles({
    start = 0x400000n,
    end = 0x402000n,
    pageSize = 4096n,
    pageOffset = 2n,
    pathname = Buffer.from("/fixture/native-probe\0"),
} = {}) {
    const data = Buffer.alloc(40 + pathname.length);
    data.writeBigUInt64LE(1n, 0);
    data.writeBigUInt64LE(pageSize, 8);
    data.writeBigUInt64LE(start, 16);
    data.writeBigUInt64LE(end, 24);
    data.writeBigUInt64LE(pageOffset, 32);
    pathname.copy(data, 40);
    return data;
}

const defaultNotes = () => [
    note(1, thread()),
    note(3, processInfo()),
    note(0x53494749, signal()),
    note(0x46494c45, mappedFiles()),
    note(1, thread({ tid: LEADER, rip: 0x401020n, rsp: 0x7fffffffe000n })),
];

function core({
    notes = defaultNotes(),
    loads = [
        { address: 0x400000n, memoryBytes: 0x2000n, fileBytes: 0n, flags: 5 },
    ],
} = {}) {
    const count = 1 + loads.length;
    const noteOffset = 64 + count * 56;
    const description = Buffer.concat(notes);
    const bytes = Buffer.alloc(noteOffset + description.length);
    Buffer.from("7f454c4602010100", "hex").copy(bytes);
    bytes.writeUInt16LE(4, 16); // ET_CORE
    bytes.writeUInt16LE(62, 18); // EM_X86_64
    bytes.writeUInt32LE(1, 20);
    bytes.writeBigUInt64LE(64n, 32);
    bytes.writeUInt16LE(64, 52);
    bytes.writeUInt16LE(56, 54);
    bytes.writeUInt16LE(count, 56);
    bytes.writeUInt32LE(4, 64); // PT_NOTE
    bytes.writeBigUInt64LE(BigInt(noteOffset), 72);
    bytes.writeBigUInt64LE(BigInt(description.length), 96);
    for (const [index, load] of loads.entries()) {
        const offset = 64 + (index + 1) * 56;
        bytes.writeUInt32LE(1, offset); // PT_LOAD
        bytes.writeUInt32LE(load.flags, offset + 4);
        bytes.writeBigUInt64LE(load.fileOffset ?? 0n, offset + 8);
        bytes.writeBigUInt64LE(load.address, offset + 16);
        bytes.writeBigUInt64LE(load.fileBytes, offset + 32);
        bytes.writeBigUInt64LE(load.memoryBytes, offset + 40);
        bytes.writeBigUInt64LE(4096n, offset + 48);
    }
    description.copy(bytes, noteOffset);
    return bytes;
}

test("Linux writer order selects a crashing worker TID instead of leader or matching cursig", () => {
    const actual = parseElfCoreNotes(core());
    assert.equal(actual.notesComplete, true);
    assert.deepEqual(actual.missingNotes, []);
    assert.equal(actual.threadSelection, "linux-v6.6-first-prstatus");
    assert.deepEqual(
        actual.threads.map(({ tid }) => tid),
        [CRASHING_TID, LEADER],
    );
    assert.deepEqual(
        actual.threads.map(({ currentSignal }) => currentSignal),
        [11, 11],
    );
    assert.equal(actual.crashingThread.tid, CRASHING_TID);
    assert.notEqual(actual.crashingThread.tid, LEADER);
});

test("x86-64 PRSTATUS retains exact registers beyond Number precision and the ABI RIP/RSP offsets", () => {
    const { crashingThread } = parseElfCoreNotes(core());
    assert.equal(crashingThread.registers.r15, "0x20000000000001");
    assert.equal(crashingThread.registers.rax, "0x2000000000000b");
    assert.equal(crashingThread.registers.rip, "0x400120");
    assert.equal(crashingThread.registers.rsp, "0x7fffffff0008");
    assert.equal(crashingThread.registers.gs, "0x2000000000001b");
    assert.equal(Object.keys(crashingThread.registers).length, 27);
});

test("NT_SIGINFO decodes errno at four and code at eight with a genuine zero fault address", () => {
    const actual = parseElfCoreNotes(core()).signal;
    assert.equal(actual.number, 11);
    assert.equal(actual.errno, 7);
    assert.equal(actual.code, 1);
    assert.equal(actual.faultAddress, "0x0");
    assert.equal("senderPid" in actual, false);
});

test("SI_TKILL sender identity cannot be reported as an original memory fault address", () => {
    const actual = parseElfCoreNotes(
        core({
            notes: [
                note(1, thread()),
                note(0x53494749, signal({ code: -6 })),
                note(0x46494c45, mappedFiles()),
            ],
        }),
    ).signal;
    assert.equal(actual.code, -6);
    assert.equal(actual.senderPid, 505);
    assert.equal(actual.senderUid, 606);
    assert.equal("faultAddress" in actual, false);
});

test("only explicit sender unions are decoded and unknown/timer/architecture-specific payloads remain raw", () => {
    for (const code of [0, -1, -6, -2, -3, -4, -5, -7, 128, 8, 9, 77]) {
        const raw = signal({ code, address: 0x1234n });
        const actual = parseElfCoreNotes(
            core({
                notes: [
                    note(1, thread()),
                    note(0x53494749, raw),
                    note(0x46494c45, mappedFiles()),
                ],
            }),
        ).signal;
        assert.equal(actual.rawHex, raw.toString("hex"));
        assert.equal("senderPid" in actual, [0, -1, -6].includes(code));
        assert.equal("faultAddress" in actual, false);
    }
});

test("the x86 address-bearing SIGSEGV codes include control protection without decoding ARM asynchronous MTE", () => {
    for (const code of [1, 2, 3, 4, 10]) {
        const actual = parseElfCoreNotes(
            core({
                notes: [
                    note(1, thread()),
                    note(0x53494749, signal({ code, address: 0x1234n })),
                    note(0x46494c45, mappedFiles()),
                ],
            }),
        ).signal;
        assert.equal(actual.faultAddress, "0x1234");
    }
});

test("mapping arithmetic uses declared NT_FILE page units and executable memory ranges even with zero captured load bytes", () => {
    const actual = parseElfCoreNotes(
        core({
            notes: [
                note(1, thread()),
                note(0x53494749, signal()),
                note(
                    0x46494c45,
                    mappedFiles({ pageSize: 65536n, pageOffset: 3n }),
                ),
            ],
        }),
    );
    assert.equal(actual.executable, true);
    assert.equal(actual.loadSegmentsComplete, true);
    assert.equal(actual.fileMapping.file, "/fixture/native-probe");
    assert.equal(actual.fileMapping.fileOffset, "0x30000");
    assert.equal(actual.fileMapping.instructionFileOffset, "0x30120");
});

test("anonymous executable and mapped non-executable RIPs remain distinct observations", () => {
    const anonymous = parseElfCoreNotes(
        core({
            notes: [
                note(1, thread()),
                note(0x53494749, signal()),
                note(
                    0x46494c45,
                    mappedFiles({ start: 0x500000n, end: 0x502000n }),
                ),
            ],
        }),
    );
    assert.equal(anonymous.executable, true);
    assert.equal(anonymous.fileMapping, null);
    const dataMapping = parseElfCoreNotes(
        core({
            loads: [
                {
                    address: 0x400000n,
                    memoryBytes: 0x2000n,
                    fileBytes: 0n,
                    flags: 6,
                },
            ],
        }),
    );
    assert.equal(dataMapping.executable, false);
    assert.equal(dataMapping.fileMapping.file, "/fixture/native-probe");
});

test("missing mandatory notes are explicit incomplete capture rather than invented thread or signal evidence", () => {
    for (const [type, expected] of [
        [1, "NT_PRSTATUS"],
        [0x53494749, "NT_SIGINFO"],
        [0x46494c45, "NT_FILE"],
    ]) {
        const actual = parseElfCoreNotes(
            core({
                notes: defaultNotes().filter(
                    (entry) => entry.readUInt32LE(8) !== type,
                ),
            }),
        );
        assert.equal(actual.notesComplete, false);
        assert.deepEqual(actual.missingNotes, [expected]);
        if (type === 1) assert.equal(actual.crashingThread, undefined);
        if (type === 0x53494749) assert.equal(actual.signal, undefined);
    }
});

test("duplicate process-wide signal or file tables cannot yield an apparently complete capture", () => {
    for (const duplicate of [
        note(0x53494749, signal()),
        note(0x46494c45, mappedFiles()),
    ])
        assert.throws(
            () =>
                parseElfCoreNotes(
                    core({ notes: [...defaultNotes(), duplicate] }),
                ),
            /Duplicate/,
        );
});

test("non-CORE note owners cannot satisfy required Linux note identities", () => {
    const actual = parseElfCoreNotes(
        core({
            notes: [
                note(1, thread(), Buffer.from("OTHER\0")),
                note(0x53494749, signal(), Buffer.from("OTHER\0")),
                note(0x46494c45, mappedFiles(), Buffer.from("OTHER\0")),
            ],
        }),
    );
    assert.equal(actual.notesComplete, false);
    assert.deepEqual(actual.missingNotes, [
        "NT_PRSTATUS",
        "NT_SIGINFO",
        "NT_FILE",
    ]);
});

test("unsupported ELF architecture/class/endian/header widths and extended header counts are rejected", () => {
    const changes = [
        (bytes) => {
            bytes[4] = 1;
        },
        (bytes) => {
            bytes[5] = 2;
        },
        (bytes) => bytes.writeUInt16LE(2, 16),
        (bytes) => bytes.writeUInt16LE(183, 18),
        (bytes) => bytes.writeUInt16LE(63, 52),
        (bytes) => bytes.writeUInt16LE(55, 54),
        (bytes) => bytes.writeUInt16LE(0xffff, 56),
    ];
    for (const change of changes) {
        const bytes = core();
        change(bytes);
        assert.throws(() => parseElfCoreNotes(bytes), /supported|header/);
    }
});

test("incomplete or impossible program-header and note spans fail before interpretation", () => {
    for (const change of [
        (bytes) => bytes.writeBigUInt64LE(U64_MAX, 32),
        (bytes) => bytes.writeBigUInt64LE(BigInt(bytes.length - 4), 32),
        (bytes) => bytes.writeBigUInt64LE(U64_MAX, 72),
        (bytes) => bytes.writeBigUInt64LE(BigInt(bytes.length), 96),
    ]) {
        const bytes = core();
        change(bytes);
        assert.throws(
            () => parseElfCoreNotes(bytes),
            /[Oo]versized|[Ii]ncomplete|invalid|[Oo]verflow/,
        );
    }
    assert.throws(() => parseElfCoreNotes(core().subarray(0, 63)), /bounded/);
    assert.throws(
        () => parseElfCoreNotes(Buffer.alloc(ELF_CORE_LIMITS.bytes + 1)),
        /bounded/,
    );
    assert.throws(
        () => parseElfCoreNotes(core().subarray(0, -1)),
        /Incomplete/,
    );
});

test("oversized note payload/thread counts and incomplete fixed layouts cannot be accepted", () => {
    const bytes = core();
    const at = Number(bytes.readBigUInt64LE(72));
    bytes.writeUInt32LE(ELF_CORE_LIMITS.noteBytes + 1, at + 4);
    assert.throws(() => parseElfCoreNotes(bytes), /[Oo]versized/);
    assert.throws(
        () =>
            parseElfCoreNotes(
                core({ notes: [note(1, thread().subarray(0, 335))] }),
            ),
        /PRSTATUS/,
    );
    assert.throws(
        () =>
            parseElfCoreNotes(
                core({ notes: [note(0x53494749, signal().subarray(0, 127))] }),
            ),
        /NT_SIGINFO/,
    );
    assert.throws(
        () =>
            parseElfCoreNotes(
                core({
                    notes: Array.from(
                        { length: ELF_CORE_LIMITS.threads + 1 },
                        (_, index) => note(1, thread({ tid: index + 1 })),
                    ),
                }),
            ),
        /thread count/,
    );
});

test("invalid file table counts/pages/ranges/paths are bounded even with hostile wire values", () => {
    for (const data of [
        mappedFiles({ pageSize: 0n }),
        mappedFiles({ pageSize: 3n }),
        mappedFiles({ end: 0x400000n }),
        mappedFiles({ pathname: Buffer.from("missing-terminator") }),
        mappedFiles({ pathname: Buffer.from("invalid\npath\0") }),
        mappedFiles({ pathname: Buffer.from([0xff, 0]) }),
        mappedFiles({
            pathname: Buffer.concat([
                Buffer.alloc(ELF_CORE_LIMITS.pathBytes + 1, 0x61),
                Buffer.from([0]),
            ]),
        }),
        Buffer.alloc(15),
        (() => {
            const data = mappedFiles();
            data.writeBigUInt64LE(U64_MAX, 0);
            return data;
        })(),
    ])
        assert.throws(() =>
            parseElfCoreNotes(core({ notes: [note(0x46494c45, data)] })),
        );
});

test("load and NT_FILE arithmetic rejects impossible uint64 ranges and offset products", () => {
    assert.throws(
        () =>
            parseElfCoreNotes(
                core({
                    loads: [
                        {
                            address: U64_MAX - 1n,
                            memoryBytes: 4n,
                            fileBytes: 0n,
                            flags: 5,
                        },
                    ],
                }),
            ),
        /[Oo]verflow/,
    );
    assert.throws(
        () =>
            parseElfCoreNotes(
                core({
                    notes: [
                        note(
                            0x46494c45,
                            mappedFiles({
                                pageOffset: U64_MAX,
                                pageSize: 4096n,
                            }),
                        ),
                    ],
                }),
            ),
        /[Oo]verflow|[Oo]versized/,
    );
    assert.throws(
        () =>
            parseElfCoreNotes(
                core({
                    notes: [
                        note(1, thread()),
                        note(
                            0x46494c45,
                            mappedFiles({
                                pageOffset: U64_MAX - 1n,
                                pageSize: 1n,
                            }),
                        ),
                    ],
                }),
            ),
        /[Oo]verflow|[Oo]versized/,
    );
});

test("truncated optional memory bytes retain complete note evidence with explicit incomplete-load status", () => {
    const actual = parseElfCoreNotes(
        core({
            loads: [
                {
                    address: 0x400000n,
                    memoryBytes: 0x2000n,
                    fileBytes: 0x1000n,
                    fileOffset: 0x100000n,
                    flags: 5,
                },
            ],
        }),
    );
    assert.equal(actual.notesComplete, true);
    assert.equal(actual.loadSegmentsComplete, false);
    assert.equal(actual.crashingThread.registers.rip, "0x400120");
});
