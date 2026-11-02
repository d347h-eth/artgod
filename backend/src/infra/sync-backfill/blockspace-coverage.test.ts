import { describe, it, expect } from "vitest";
import {
    BLOCKSPACE_COVERAGE_LIMITS,
    BLOCKSPACE_COVERAGE_REPRESENTATION,
    BlockspaceCoverageBuilder,
} from "./blockspace-coverage.js";

const cooperate = async () => {};

describe("adaptive blockspace coverage", () => {
    it("counts inclusive interval boundaries, merged batches, empty and reversed ranges", async () => {
        const builder = new BlockspaceCoverageBuilder(17, 1_000_000);
        builder.append(17, 31);
        builder.append(32, 65);
        builder.append(100, 140);
        builder.append(1_000_000, 1_000_000);
        const snapshot = await builder.finish(cooperate);
        expect(snapshot.representation).toBe(
            BLOCKSPACE_COVERAGE_REPRESENTATION.Intervals,
        );
        const members = [
            ...Array.from({ length: 49 }, (_, i) => i + 17),
            ...Array.from({ length: 41 }, (_, i) => i + 100),
            1_000_000,
        ];
        for (let from = 0; from < 150; from += 1) {
            for (let to = from - 1; to < 151; to += 1) {
                expect(snapshot.count({ fromBlock: from, toBlock: to })).toBe(
                    members.filter((block) => block >= from && block <= to)
                        .length,
                );
            }
        }
        expect(snapshot.total).toBe(members.length);
        expect(snapshot.count({ fromBlock: 0, toBlock: 2_000_000 })).toBe(
            members.length,
        );
        const empty = await new BlockspaceCoverageBuilder(17, 1_000_000).finish(
            cooperate,
        );
        expect(empty.total).toBe(0);
        expect(empty.count({ fromBlock: 0, toBlock: 1_000_000 })).toBe(0);
    });

    it("preserves bitmap masks and prefix boundaries with a nonaligned deployment", async () => {
        const from = 17,
            to = 17 + 4096 + 19;
        const builder = new BlockspaceCoverageBuilder(from, to);
        const members: number[] = [];
        for (let block = from; block <= to; block += 2) {
            builder.append(block, block);
            members.push(block);
            if (block % 128 === 17) await builder.compact(cooperate);
        }
        const snapshot = await builder.finish(cooperate);
        expect(snapshot.representation).toBe(
            BLOCKSPACE_COVERAGE_REPRESENTATION.Bitmap,
        );
        for (const a of [
            -1, 0, 1, 15, 16, 17, 18, 31, 32, 33, 1023, 1024, 1025, 2048, 4095,
            4096, 5000,
        ]) {
            for (const b of [
                a - 1,
                a,
                a + 1,
                a + 31,
                a + 32,
                a + 1024,
                to + 1,
            ]) {
                const range = { fromBlock: a + from, toBlock: b + from };
                expect(snapshot.count(range)).toBe(
                    members.filter(
                        (n) => n >= range.fromBlock && n <= range.toBlock,
                    ).length,
                );
            }
        }
        expect(snapshot.total).toBe(members.length);
    });

    it("converts more than one million disjoint memberships without interval capacity failure", async () => {
        const count = 1_100_001;
        const builder = new BlockspaceCoverageBuilder(0, count * 2);
        for (let i = 0; i < count; i += 1) {
            builder.append(i * 2, i * 2);
            if (i % 4096 === 4095) await builder.compact(cooperate);
        }
        const snapshot = await builder.finish(cooperate);
        expect(snapshot.representation).toBe(
            BLOCKSPACE_COVERAGE_REPRESENTATION.Bitmap,
        );
        expect(snapshot.total).toBe(count);
        expect(snapshot.count({ fromBlock: 31, toBlock: count * 2 })).toBe(
            count - 16,
        );
        expect(snapshot.byteLength).toBeLessThan(
            BLOCKSPACE_COVERAGE_LIMITS.maxBitmapBytes,
        );
    });
});
