import {
    NATIVE_CORE_CONTEXT_POLICY,
    NATIVE_MEMORY_WINDOW,
} from "./native-failure-evidence.mjs";

const MAX_ADDRESS = 1n << 64n;
const hex = (value) => `0x${value.toString(16)}`;

/** Linux proc maps are independent observations, not NT_FILE's file-only view. */
export function parseNativeProcessMaps(text) {
    if (
        typeof text !== "string" ||
        Buffer.byteLength(text) > NATIVE_CORE_CONTEXT_POLICY.mapsBytes
    )
        throw new Error("Process maps exceed the bounded context policy");
    const lines = text.trimEnd().split("\n");
    if (lines.length > NATIVE_CORE_CONTEXT_POLICY.mapEntries)
        throw new Error("Process mapping count exceeds the context policy");
    let previousEnd = 0n;
    return lines.map((line) => {
        const match = line.match(
            /^([0-9a-f]+)-([0-9a-f]+)\s+([r-][w-][x-][ps])\s+([0-9a-f]+)\s+[0-9a-f]+:[0-9a-f]+\s+\d+\s*(.*)$/i,
        );
        if (!match) throw new Error("Unsupported process mapping line");
        const start = BigInt(`0x${match[1]}`),
            end = BigInt(`0x${match[2]}`);
        if (start < previousEnd || start >= end || end >= MAX_ADDRESS)
            throw new Error("Invalid or overlapping process mapping");
        const fileOffset = BigInt(`0x${match[4]}`);
        if (fileOffset >= MAX_ADDRESS)
            throw new Error("Overflowing process mapping file offset");
        previousEnd = end;
        return {
            start: hex(start),
            end: hex(end),
            permissions: match[3],
            fileOffset: hex(fileOffset),
            name: match[5],
        };
    });
}

export function nativeMemoryWindow(mapping, address, kind) {
    if (!mapping || mapping.permissions[0] !== "r")
        throw new Error(`No readable mapping for ${kind}`);
    address = BigInt(address);
    const begin = BigInt(mapping.start),
        end = BigInt(mapping.end);
    if (address < begin || address >= end)
        throw new Error("Register address escapes its observed mapping");
    const maximum =
        kind === NATIVE_MEMORY_WINDOW.Stack
            ? NATIVE_CORE_CONTEXT_POLICY.stackBytes
            : kind === NATIVE_MEMORY_WINDOW.Instructions
              ? NATIVE_CORE_CONTEXT_POLICY.instructionBytes
              : 0;
    if (!maximum) throw new Error("Unknown native memory window");
    const before = kind === NATIVE_MEMORY_WINDOW.Stack ? 128n : 32n;
    const start = address - begin > before ? address - before : begin;
    const size = end - start < BigInt(maximum) ? Number(end - start) : maximum;
    return {
        kind,
        address: hex(start),
        registerAddress: hex(address),
        registerOffset: Number(address - start),
        requestedBytes: size,
        mapping,
    };
}

/** Read a fixed byte ceiling from a proc file whose stat size is zero. */
export async function readNativeProcText(io, filename, maximum) {
    const handle = await io.open(filename, "r");
    try {
        const buffer = Buffer.alloc(maximum + 1);
        let size = 0;
        while (size < buffer.length) {
            const result = await handle.read({
                buffer,
                offset: size,
                length: buffer.length - size,
                position: BigInt(size),
            });
            if (!result.bytesRead) break;
            size += result.bytesRead;
        }
        if (size > maximum)
            throw new Error("Native proc text exceeded its byte ceiling");
        return buffer.subarray(0, size).toString("utf8");
    } finally {
        await handle.close();
    }
}

/** Only the retained crashing task's validated register windows are read. */
export async function readNativeMemoryWindows(io, pid, notes, maps) {
    const result = {};
    const handle = await io.open(`/proc/${pid}/mem`, "r");
    try {
        for (const [kind, register] of [
            [NATIVE_MEMORY_WINDOW.Stack, "rsp"],
            [NATIVE_MEMORY_WINDOW.Instructions, "rip"],
        ]) {
            let window;
            try {
                const address = BigInt(
                    notes.crashingThread.registers[register],
                );
                const mapping = maps.find(
                    (item) =>
                        BigInt(item.start) <= address &&
                        address < BigInt(item.end),
                );
                window = nativeMemoryWindow(mapping, address, kind);
                const bytes = Buffer.alloc(window.requestedBytes);
                let size = 0;
                while (size < bytes.length) {
                    const read = await handle.read({
                        buffer: bytes,
                        offset: size,
                        length: bytes.length - size,
                        position: BigInt(window.address) + BigInt(size),
                    });
                    if (!read.bytesRead) break;
                    size += read.bytesRead;
                }
                result[kind] = {
                    ...window,
                    bytes: bytes.subarray(0, size),
                    complete: size === window.requestedBytes,
                };
                if (size !== window.requestedBytes)
                    result[kind].error =
                        "Short read from the retained process mapping";
            } catch (error) {
                result[kind] = {
                    ...window,
                    complete: false,
                    error: error.message,
                };
            }
        }
    } finally {
        await handle.close();
    }
    return result;
}
