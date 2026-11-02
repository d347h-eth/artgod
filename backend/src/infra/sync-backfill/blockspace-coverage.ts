import type { SyncBackfillCoverageRange } from "../../application/use-cases/sync-backfill/get-sync-backfill-state.js";
import { PublicBlockspaceUnavailableError } from "../../application/use-cases/sync-backfill/public-blockspace-coverage.js";

export const BLOCKSPACE_COVERAGE_REPRESENTATION = {
    Intervals: "intervals",
    Bitmap: "bitmap",
} as const;

export const BLOCKSPACE_COVERAGE_LIMITS = Object.freeze({
    maxBitmapBytes: 32 * 1024 * 1024,
    maxIntervals: 65_536,
    countStepBlocks: 65_536,
    extractionStepBlocks: 16_384,
    prefixStepBlocks: 1_024,
});

export type BlockspaceCoverage = {
    readonly representation: (typeof BLOCKSPACE_COVERAGE_REPRESENTATION)[keyof typeof BLOCKSPACE_COVERAGE_REPRESENTATION];
    readonly total: number;
    readonly byteLength: number;
    count(range: SyncBackfillCoverageRange): number;
};

type Cooperate = () => Promise<void>;

/** Ordered, unique membership becomes intervals until a bitmap costs less. */
export class BlockspaceCoverageBuilder {
    private starts: number[] = [];
    private ends: number[] = [];
    private prefixBefore: number[] = [];
    private words: Uint32Array | null = null;
    private total = 0;
    private readonly wordCount: number;

    constructor(
        private readonly fromBlock: number,
        private readonly toBlock: number,
    ) {
        this.wordCount = Math.ceil(Math.max(0, toBlock - fromBlock + 1) / 32);
    }

    /** Call only with disjoint, ascending ranges bounded by a count/extraction step. */
    append(fromBlock: number, toBlock: number): void {
        if (this.words) {
            setBits(
                this.words,
                fromBlock - this.fromBlock,
                toBlock - this.fromBlock,
            );
        } else {
            const last = this.ends.length - 1;
            if (last >= 0 && fromBlock === this.ends[last] + 1) {
                this.ends[last] = toBlock;
            } else {
                // One extraction batch can temporarily exceed the conversion
                // threshold, but cannot grow without bound on huge chain spans.
                if (
                    this.starts.length >=
                    BLOCKSPACE_COVERAGE_LIMITS.maxIntervals +
                        BLOCKSPACE_COVERAGE_LIMITS.extractionStepBlocks
                ) {
                    throw new PublicBlockspaceUnavailableError({
                        cause: new Error(
                            "Blockspace interval capacity exceeded",
                        ),
                    });
                }
                this.starts.push(fromBlock);
                this.ends.push(toBlock);
                this.prefixBefore.push(this.total);
            }
        }
        this.total += toBlock - fromBlock + 1;
    }

    async compact(cooperate: Cooperate): Promise<void> {
        if (this.words) return;
        const bitmapBytes = this.wordCount * Uint32Array.BYTES_PER_ELEMENT;
        const prefixBytes =
            (Math.ceil(this.wordCount / 32) + 1) *
            Float64Array.BYTES_PER_ELEMENT;
        const threshold = Math.min(
            BLOCKSPACE_COVERAGE_LIMITS.maxIntervals,
            Math.max(1, Math.ceil((bitmapBytes + prefixBytes) / 24)),
        );
        if (this.starts.length < threshold) return;
        if (bitmapBytes > BLOCKSPACE_COVERAGE_LIMITS.maxBitmapBytes) {
            if (this.starts.length >= BLOCKSPACE_COVERAGE_LIMITS.maxIntervals) {
                throw new PublicBlockspaceUnavailableError({
                    cause: new Error("Blockspace bitmap capacity exceeded"),
                });
            }
            return;
        }
        const words = new Uint32Array(this.wordCount);
        // Even a previously merged dense interval is copied in bounded steps.
        for (let index = 0; index < this.starts.length; index += 1) {
            for (
                let from = this.starts[index];
                from <= this.ends[index];
                from += BLOCKSPACE_COVERAGE_LIMITS.countStepBlocks
            ) {
                setBits(
                    words,
                    from - this.fromBlock,
                    Math.min(
                        this.ends[index],
                        from + BLOCKSPACE_COVERAGE_LIMITS.countStepBlocks - 1,
                    ) - this.fromBlock,
                );
                await cooperate();
            }
        }
        this.words = words;
        this.starts = [];
        this.ends = [];
        this.prefixBefore = [];
    }

    async finish(cooperate: Cooperate): Promise<BlockspaceCoverage> {
        await this.compact(cooperate);
        if (!this.words) {
            return new IntervalCoverage(
                Float64Array.from(this.starts),
                Float64Array.from(this.ends),
                Float64Array.from(this.prefixBefore),
                this.total,
            );
        }
        const prefix = new Float64Array(Math.ceil(this.wordCount / 32) + 1);
        for (let index = 0; index < prefix.length - 1; index += 1) {
            prefix[index + 1] =
                prefix[index] +
                countBits(
                    this.words,
                    index * 1024,
                    Math.min(this.wordCount * 32 - 1, (index + 1) * 1024 - 1),
                );
            if (index % 256 === 255) await cooperate();
        }
        return new BitmapCoverage(
            this.fromBlock,
            this.toBlock,
            this.words,
            prefix,
            this.total,
        );
    }
}

class IntervalCoverage implements BlockspaceCoverage {
    readonly representation = BLOCKSPACE_COVERAGE_REPRESENTATION.Intervals;
    readonly byteLength: number;

    constructor(
        private readonly starts: Float64Array,
        private readonly ends: Float64Array,
        private readonly prefixBefore: Float64Array,
        readonly total: number,
    ) {
        this.byteLength =
            starts.byteLength + ends.byteLength + prefixBefore.byteLength;
    }

    count({ fromBlock, toBlock }: SyncBackfillCoverageRange): number {
        if (fromBlock > toBlock) return 0;
        return this.before(toBlock + 1) - this.before(fromBlock);
    }

    private before(block: number): number {
        let low = 0;
        let high = this.starts.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (this.starts[middle] < block) low = middle + 1;
            else high = middle;
        }
        if (low === 0) return 0;
        const index = low - 1;
        return (
            this.prefixBefore[index] +
            Math.min(
                block - this.starts[index],
                this.ends[index] - this.starts[index] + 1,
            )
        );
    }
}

class BitmapCoverage implements BlockspaceCoverage {
    readonly representation = BLOCKSPACE_COVERAGE_REPRESENTATION.Bitmap;
    readonly byteLength: number;

    constructor(
        private readonly fromBlock: number,
        private readonly toBlock: number,
        private readonly words: Uint32Array,
        private readonly prefix: Float64Array,
        readonly total: number,
    ) {
        this.byteLength = words.byteLength + prefix.byteLength;
    }

    count(range: SyncBackfillCoverageRange): number {
        const from = Math.max(this.fromBlock, range.fromBlock);
        const to = Math.min(this.toBlock, range.toBlock);
        if (from > to) return 0;
        return (
            this.before(to - this.fromBlock + 1) -
            this.before(from - this.fromBlock)
        );
    }

    private before(offset: number): number {
        const group = Math.floor(
            offset / BLOCKSPACE_COVERAGE_LIMITS.prefixStepBlocks,
        );
        return (
            this.prefix[group] +
            countBits(
                this.words,
                group * BLOCKSPACE_COVERAGE_LIMITS.prefixStepBlocks,
                offset - 1,
            )
        );
    }
}

function setBits(words: Uint32Array, from: number, to: number): void {
    const first = Math.floor(from / 32);
    const last = Math.floor(to / 32);
    const left = 0xffffffff << (from % 32);
    const right = 0xffffffff >>> (31 - (to % 32));
    if (first === last) words[first] |= left & right;
    else {
        words[first] |= left;
        words.fill(0xffffffff, first + 1, last);
        words[last] |= right;
    }
}

function countBits(words: Uint32Array, from: number, to: number): number {
    if (from > to) return 0;
    const first = Math.floor(from / 32);
    const last = Math.floor(to / 32);
    const left = 0xffffffff << (from % 32);
    const right = 0xffffffff >>> (31 - (to % 32));
    if (first === last) return popcount(words[first] & left & right);
    let count = popcount(words[first] & left) + popcount(words[last] & right);
    for (let index = first + 1; index < last; index += 1)
        count += popcount(words[index]);
    return count;
}

function popcount(value: number): number {
    value -= (value >>> 1) & 0x55555555;
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
