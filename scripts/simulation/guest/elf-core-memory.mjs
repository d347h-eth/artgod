import { NATIVE_MEMORY_WINDOW } from "./native-failure-evidence.mjs";
import { createHash } from "node:crypto";
import {
    readElfCoreLayout,
    parseElfCoreNotes,
    ELF_CORE_LIMITS,
} from "./elf-core-notes.mjs";

export const ELF_CORE_MEMORY_LIMITS = Object.freeze({
    windows: 2,
    windowBytes: 64 * 1024,
    derivedBytes: ELF_CORE_LIMITS.bytes + 192 * 1024,
    loadAlignment: 4096,
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hex = (value) => `0x${value.toString(16)}`;

/** Derive an analysis core. Raw notes remain byte-identical; added pages are
 * separately captured evidence, never represented as kernel-dumped bytes. */
export function enrichElfCoreMemory(raw, windows) {
    const notes = parseElfCoreNotes(raw);
    if (!notes.notesComplete || !notes.loadSegmentsComplete)
        throw new Error("Cannot enrich an incomplete raw core");
    if (
        !Array.isArray(windows) ||
        windows.length < 1 ||
        windows.length > ELF_CORE_MEMORY_LIMITS.windows
    )
        throw new Error("A small explicit memory-window set is required");
    const layout = readElfCoreLayout(raw);
    const captures = windows.map((window) => {
        const address = BigInt(window.address);
        if (
            !Object.values(NATIVE_MEMORY_WINDOW).includes(window.kind) ||
            !Buffer.isBuffer(window.bytes) ||
            window.bytes.length < 1 ||
            window.bytes.length > ELF_CORE_MEMORY_LIMITS.windowBytes ||
            address < 0n ||
            address + BigInt(window.bytes.length) >= 1n << 64n
        )
            throw new Error("Invalid bounded captured-memory window");
        const end = address + BigInt(window.bytes.length);
        if (
            !layout.headers.some(
                (header) =>
                    header.type === 1 &&
                    header.address <= address &&
                    end <= header.address + header.memoryBytes,
            )
        )
            throw new Error("Captured memory escapes the raw core mapping");
        return { ...window, address, end };
    });
    const segments = [],
        provenance = [];
    for (const header of layout.headers) {
        if (![1, 4].includes(header.type))
            throw new Error("Unsupported raw core segment for enrichment");
        if (header.type === 4) {
            segments.push({
                ...header,
                data: raw.subarray(
                    Number(header.offset),
                    Number(header.offset + header.fileBytes),
                ),
                source: "raw-notes",
                sourceOffset: Number(header.offset),
            });
            continue;
        }
        if (header.fileBytes > header.memoryBytes)
            throw new Error("Invalid raw core load size");
        const end = header.address + header.memoryBytes;
        const relevant = captures.filter(
            (window) => header.address <= window.address && window.end <= end,
        );
        if (!relevant.length) {
            segments.push({
                ...header,
                data: raw.subarray(
                    Number(header.offset),
                    Number(header.offset + header.fileBytes),
                ),
                source: "raw-load",
                sourceOffset: Number(header.offset),
            });
            continue;
        }
        const originalEnd = header.address + header.fileBytes;
        const boundaries = [
            ...new Set([
                header.address,
                end,
                originalEnd,
                ...relevant.flatMap((window) => [window.address, window.end]),
            ]),
        ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        for (let index = 0; index < boundaries.length - 1; index++) {
            const start = boundaries[index],
                stop = boundaries[index + 1];
            if (start === stop) continue;
            let data,
                sourceOffset = 0,
                source = "omitted";
            if (start < originalEnd) {
                const offset = header.offset + start - header.address;
                data = raw.subarray(
                    Number(offset),
                    Number(offset + stop - start),
                );
                source = "raw-load";
                sourceOffset = Number(offset);
            }
            for (const window of relevant.filter(
                (window) => window.address <= start && stop <= window.end,
            )) {
                const captured = window.bytes.subarray(
                    Number(start - window.address),
                    Number(stop - window.address),
                );
                if (data && !data.equals(captured))
                    throw new Error(
                        "Captured memory differs from an existing raw core byte",
                    );
                data = captured;
                source = window.kind;
                sourceOffset = Number(start - window.address);
            }
            segments.push({
                ...header,
                address: start,
                memoryBytes: stop - start,
                fileBytes: BigInt(data?.length ?? 0),
                data: data ?? Buffer.alloc(0),
                source,
                sourceOffset,
            });
        }
    }
    if (segments.length > ELF_CORE_LIMITS.headers)
        throw new Error("Enriched core header limit exceeded");
    let offset = 64 + segments.length * 56;
    let extent = offset;
    for (const segment of segments) {
        const alignment =
            segment.type === 4 ? 4 : ELF_CORE_MEMORY_LIMITS.loadAlignment;
        const remainder =
            segment.type === 4
                ? 0
                : Number(segment.address % BigInt(alignment));
        // Preserve Linux page-congruent LOAD layout: repacking with p_align=1
        // made libdwfl report spurious modules at omitted ranges in an actual
        // retained runtime core, although all captured bytes still matched.
        segment.outputOffset =
            offset +
            ((remainder - (offset % alignment) + alignment) % alignment);
        const end = segment.outputOffset + segment.data.length;
        extent = Math.max(extent, end);
        // An omitted mapping contributes no memory bytes. Its congruent file
        // offset may overlap padding/later data, and costs at most one final
        // page of file extent rather than one allocation per zero-data range.
        if (segment.data.length) offset = end;
        if (extent > ELF_CORE_MEMORY_LIMITS.derivedBytes)
            throw new Error("Enriched core byte limit exceeded");
    }
    const bytes = Buffer.alloc(extent);
    raw.copy(bytes, 0, 0, 64);
    bytes.writeBigUInt64LE(64n, 32);
    bytes.writeBigUInt64LE(0n, 40);
    bytes.writeUInt16LE(segments.length, 56);
    bytes.writeUInt16LE(0, 58);
    bytes.writeUInt16LE(0, 60);
    bytes.writeUInt16LE(0, 62);
    for (const [index, segment] of segments.entries()) {
        const at = 64 + index * 56;
        bytes.writeUInt32LE(segment.type, at);
        bytes.writeUInt32LE(segment.flags, at + 4);
        bytes.writeBigUInt64LE(BigInt(segment.outputOffset), at + 8);
        bytes.writeBigUInt64LE(segment.address, at + 16);
        bytes.writeBigUInt64LE(0n, at + 24);
        bytes.writeBigUInt64LE(BigInt(segment.data.length), at + 32);
        bytes.writeBigUInt64LE(segment.memoryBytes, at + 40);
        bytes.writeBigUInt64LE(
            segment.type === 4
                ? 4n
                : BigInt(ELF_CORE_MEMORY_LIMITS.loadAlignment),
            at + 48,
        );
        segment.data.copy(bytes, segment.outputOffset);
        if (segment.data.length)
            provenance.push({
                source: segment.source,
                sourceOffset: segment.sourceOffset,
                address: hex(segment.address),
                sizeBytes: segment.data.length,
                outputOffset: segment.outputOffset,
                sha256: hash(segment.data),
            });
    }
    return {
        bytes,
        provenance,
        rawSha256: hash(raw),
        rawSizeBytes: raw.length,
        evidence: "derived-core-with-bounded-memory-windows",
    };
}
