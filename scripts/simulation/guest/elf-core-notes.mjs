/** A bounded decoder for the pinned Linux x86-64 ELF core writer, not an unwinder. */
export const ELF_CORE_LIMITS = Object.freeze({
    bytes: 32 * 1024 * 1024,
    headers: 4096,
    notes: 4096,
    noteBytes: 4 * 1024 * 1024,
    threads: 128,
    files: 1024,
    pathBytes: 4096,
});
export const ELF_CORE_NOTE = Object.freeze({
    Prstatus: 1,
    Prpsinfo: 3,
    Siginfo: 0x53494749,
    File: 0x46494c45,
});
export const ELF_CORE_SIGNAL = Object.freeze({
    SegmentationFault: 11,
    MapError: 1,
});
const REGISTERS = Object.freeze([
    "r15",
    "r14",
    "r13",
    "r12",
    "rbp",
    "rbx",
    "r11",
    "r10",
    "r9",
    "r8",
    "rax",
    "rcx",
    "rdx",
    "rsi",
    "rdi",
    "orig_rax",
    "rip",
    "cs",
    "eflags",
    "rsp",
    "ss",
    "fs_base",
    "gs_base",
    "ds",
    "es",
    "fs",
    "gs",
]);
const hex = (value) => `0x${value.toString(16)}`;
// Linux v6.6.71 x86-64: MAPERR, ACCERR, BNDERR, PKUERR and CPERR.
// ADI/MTE codes belong to other architectures; unknown unions stay raw.
const X86_SEGV_ADDRESS_CODES = new Set([1, 2, 3, 4, 10]);
const SIGNAL_SENDER_CODES = new Set([0, -1, -6]); // SI_USER, SI_QUEUE, SI_TKILL.

export function readElfCoreLayout(bytes) {
    if (
        !Buffer.isBuffer(bytes) ||
        bytes.length < 64 ||
        bytes.length > ELF_CORE_LIMITS.bytes
    )
        throw new Error("Expected a bounded ELF core Buffer");
    const span = (offset, size, label) => {
        if (
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(size) ||
            offset < 0 ||
            size < 0 ||
            offset > bytes.length - size
        )
            throw new Error(`Incomplete or invalid ${label}`);
        return bytes.subarray(offset, offset + size);
    };
    const number = (value, label) => {
        if (value > BigInt(Number.MAX_SAFE_INTEGER))
            throw new Error(`Oversized ${label}`);
        return Number(value);
    };
    if (
        bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
        bytes[4] !== 2 ||
        bytes[5] !== 1 ||
        bytes[6] !== 1 ||
        bytes.readUInt16LE(16) !== 4 ||
        bytes.readUInt16LE(18) !== 62 ||
        bytes.readUInt32LE(20) !== 1 ||
        bytes.readUInt16LE(52) !== 64 ||
        bytes.readUInt16LE(54) !== 56
    )
        throw new Error(
            "Only ELF64 little-endian Linux x86-64 cores are supported",
        );
    const phnum = bytes.readUInt16LE(56);
    if (phnum < 1 || phnum > ELF_CORE_LIMITS.headers)
        throw new Error("Unsupported or oversized ELF program-header count");
    const phoff = number(bytes.readBigUInt64LE(32), "program-header offset");
    span(phoff, phnum * 56, "program headers");
    const noteSegments = [];
    const headers = [];
    const loads = [];
    let loadSegmentsComplete = true;
    for (let index = 0; index < phnum; index++) {
        const offset = phoff + index * 56;
        const type = bytes.readUInt32LE(offset);
        const fileOffset = bytes.readBigUInt64LE(offset + 8);
        const fileBytes = bytes.readBigUInt64LE(offset + 32);
        if (fileOffset + fileBytes >= 1n << 64n)
            throw new Error("Overflowing ELF file range");
        headers.push({
            type,
            flags: bytes.readUInt32LE(offset + 4),
            offset: fileOffset,
            fileBytes,
            address: bytes.readBigUInt64LE(offset + 16),
            memoryBytes: bytes.readBigUInt64LE(offset + 40),
            alignment: bytes.readBigUInt64LE(offset + 48),
        });
        if (type === 4) {
            const start = number(fileOffset, "note offset"),
                size = number(fileBytes, "note size");
            span(start, size, "ELF note segment");
            noteSegments.push({ start, end: start + size });
        } else if (type === 1) {
            const address = bytes.readBigUInt64LE(offset + 16);
            const memoryBytes = bytes.readBigUInt64LE(offset + 40);
            if (address + memoryBytes >= 1n << 64n)
                throw new Error("Overflowing ELF load range");
            if (fileOffset + fileBytes > BigInt(bytes.length))
                loadSegmentsComplete = false;
            loads.push({
                address,
                memoryBytes,
                executable: !!(bytes.readUInt32LE(offset + 4) & 1),
            });
        }
    }
    return { span, number, noteSegments, loads, headers, loadSegmentsComplete };
}

export function parseElfCoreNotes(bytes) {
    const { span, number, noteSegments, loads, loadSegmentsComplete } =
        readElfCoreLayout(bytes);
    const threads = [];
    let signal,
        processInfo,
        files,
        totalNotes = 0;
    const decodeThread = (data, noteOffset) => {
        if (data.length !== 336 || threads.length >= ELF_CORE_LIMITS.threads)
            throw new Error(
                "Unsupported x86-64 PRSTATUS layout or thread count",
            );
        const registers = Object.fromEntries(
            REGISTERS.map((name, index) => [
                name,
                hex(data.readBigUInt64LE(112 + index * 8)),
            ]),
        );
        return {
            tid: data.readInt32LE(32),
            currentSignal: data.readUInt16LE(12),
            registers,
            noteOffset,
        };
    };
    const decodeFiles = (data) => {
        if (data.length < 16) throw new Error("Incomplete NT_FILE header");
        const count = number(data.readBigUInt64LE(0), "NT_FILE count");
        const pageSize = data.readBigUInt64LE(8);
        if (
            count > ELF_CORE_LIMITS.files ||
            pageSize < 1n ||
            pageSize > 1048576n ||
            (pageSize & (pageSize - 1n)) !== 0n ||
            16 + count * 24 > data.length
        )
            throw new Error("Invalid or oversized NT_FILE table");
        let nameOffset = 16 + count * 24;
        const result = [];
        for (let index = 0; index < count; index++) {
            const at = 16 + index * 24;
            const start = data.readBigUInt64LE(at),
                end = data.readBigUInt64LE(at + 8);
            const pageOffset = data.readBigUInt64LE(at + 16);
            if (pageOffset * pageSize >= 1n << 64n)
                throw new Error("Overflowing NT_FILE offset");
            const terminator = data.indexOf(0, nameOffset);
            if (
                start >= end ||
                terminator < nameOffset ||
                terminator - nameOffset > ELF_CORE_LIMITS.pathBytes
            )
                throw new Error("Invalid NT_FILE range or bounded pathname");
            const file = new TextDecoder("utf-8", { fatal: true }).decode(
                data.subarray(nameOffset, terminator),
            );
            if (!file || /[\x00-\x1f]/.test(file))
                throw new Error("Unsupported NT_FILE pathname");
            result.push({
                start: hex(start),
                end: hex(end),
                fileOffset: hex(pageOffset * pageSize),
                file,
            });
            nameOffset = terminator + 1;
        }
        if (nameOffset !== data.length)
            throw new Error("Unexpected trailing NT_FILE data");
        return result;
    };
    for (const segment of noteSegments) {
        let offset = segment.start;
        while (offset < segment.end) {
            if (
                ++totalNotes > ELF_CORE_LIMITS.notes ||
                offset > segment.end - 12
            )
                throw new Error("Incomplete or oversized ELF note list");
            const nameBytes = bytes.readUInt32LE(offset),
                dataBytes = bytes.readUInt32LE(offset + 4),
                type = bytes.readUInt32LE(offset + 8);
            if (
                nameBytes < 1 ||
                nameBytes > 64 ||
                dataBytes > ELF_CORE_LIMITS.noteBytes
            )
                throw new Error("Oversized ELF note");
            const nameStart = offset + 12;
            const dataStart = nameStart + Math.ceil(nameBytes / 4) * 4;
            const next = dataStart + Math.ceil(dataBytes / 4) * 4;
            if (next > segment.end)
                throw new Error("Incomplete ELF note payload");
            const name = span(nameStart, nameBytes, "note name");
            const data = span(dataStart, dataBytes, "note payload");
            if (name.toString("ascii") === "CORE\0") {
                if (type === ELF_CORE_NOTE.Prstatus)
                    threads.push(decodeThread(data, offset));
                else if (type === ELF_CORE_NOTE.Siginfo) {
                    if (signal || data.length !== 128)
                        throw new Error("Duplicate or incomplete NT_SIGINFO");
                    const number = data.readInt32LE(0),
                        code = data.readInt32LE(8);
                    signal = {
                        number,
                        errno: data.readInt32LE(4),
                        code,
                        noteOffset: offset,
                        rawHex: data.toString("hex"),
                    };
                    if (
                        number === ELF_CORE_SIGNAL.SegmentationFault &&
                        X86_SEGV_ADDRESS_CODES.has(code)
                    )
                        signal.faultAddress = hex(data.readBigUInt64LE(16));
                    else if (SIGNAL_SENDER_CODES.has(code)) {
                        signal.senderPid = data.readInt32LE(16);
                        signal.senderUid = data.readUInt32LE(20);
                    }
                } else if (type === ELF_CORE_NOTE.Prpsinfo) {
                    if (processInfo || data.length !== 136)
                        throw new Error(
                            "Duplicate or unsupported x86-64 PRPSINFO",
                        );
                    processInfo = {
                        pid: data.readInt32LE(24),
                        parentPid: data.readInt32LE(28),
                        executableName: data
                            .subarray(40, 56)
                            .toString("utf8")
                            .split("\0")[0],
                        arguments: data
                            .subarray(56, 136)
                            .toString("utf8")
                            .split("\0")[0],
                    };
                } else if (type === ELF_CORE_NOTE.File) {
                    if (files) throw new Error("Duplicate NT_FILE");
                    files = decodeFiles(data);
                }
            }
            offset = next;
        }
    }
    const missingNotes = [];
    if (!threads.length) missingNotes.push("NT_PRSTATUS");
    if (!signal) missingNotes.push("NT_SIGINFO");
    if (!files) missingNotes.push("NT_FILE");
    // Linux fill_note_info/write_note_info writes dump_task=current first.
    // Every thread has the same pr_cursig; neither it nor leader PID selects RIP.
    const crashingThread = threads[0];
    const rip = crashingThread
        ? BigInt(crashingThread.registers.rip)
        : undefined;
    const fileMapping =
        rip === undefined
            ? undefined
            : files?.find(
                  (file) => BigInt(file.start) <= rip && rip < BigInt(file.end),
              );
    const executable =
        rip === undefined
            ? false
            : loads.some(
                  (load) =>
                      load.executable &&
                      load.address <= rip &&
                      rip < load.address + load.memoryBytes,
              );
    const instructionFileOffset = fileMapping
        ? BigInt(fileMapping.fileOffset) + rip - BigInt(fileMapping.start)
        : undefined;
    if (
        instructionFileOffset !== undefined &&
        instructionFileOffset >= 1n << 64n
    )
        throw new Error("Overflowing instruction file offset");
    return {
        notesComplete: !missingNotes.length,
        missingNotes,
        signal,
        process: processInfo,
        crashingThread,
        threadSelection: "linux-v6.6-first-prstatus",
        threads,
        files: files ?? [],
        executable,
        fileMapping: fileMapping
            ? {
                  ...fileMapping,
                  instructionFileOffset: hex(instructionFileOffset),
              }
            : null,
        loadSegmentsComplete,
    };
}
