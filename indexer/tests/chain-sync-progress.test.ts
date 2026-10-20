import { describe, expect, it } from "vitest";
import {
    canCommitValidationCheckpoint,
    ChainSyncConflict,
    type AppliedChainProgress,
    type SyncBlockHeader,
    type ValidationCheckpoint,
} from "../src/domain/chain-sync.js";
import { assertAppliedSyncRange } from "../src/domain/sync-result.js";

const block = (number: number, branch = "canonical"): SyncBlockHeader => ({
    number,
    hash: `${branch}:${number}`,
    parentHash: `${branch}:${number - 1}`,
    timestamp: number * 12,
});

const progress = (): AppliedChainProgress => ({
    checkpoint: { chainId: 1, revision: 0 },
    anchor: block(899),
    applied: block(900),
});

const checkpoint = (number: number, revision = 0): ValidationCheckpoint => ({
    chainId: 1,
    revision,
    collectionId: 1,
    block: block(number),
});

describe("ordered applied chain progress", () => {
    it("accepts a complete ascending prefix, including event-free blocks", () => {
        const before = progress();
        expect(() =>
            assertAppliedSyncRange(before, [block(901), block(902)]),
        ).not.toThrow();
        expect(before.applied.number).toBe(900);
    });

    it.each([
        ["missing predecessor", [block(902)]],
        ["reversed acquisition", [block(902), block(901)]],
        ["internal gap", [block(901), block(903)]],
        ["replayed predecessor", [block(900), block(901)]],
        ["duplicate block", [block(901), block(901)]],
        ["empty acquisition", []],
    ] as const)("rejects %s without moving progress", (_, blocks) => {
        const before = progress();
        const unchanged = structuredClone(before);
        expect(() => assertAppliedSyncRange(before, blocks)).toThrow(
            ChainSyncConflict,
        );
        expect(before).toEqual(unchanged);
    });

    it("rejects a changed branch before accepting any candidate block", () => {
        const before = progress();
        const unchanged = structuredClone(before);
        expect(() =>
            assertAppliedSyncRange(before, [block(901, "replacement")]),
        ).toThrow(ChainSyncConflict);
        expect(before).toEqual(unchanged);
    });

    it("rejects a broken internal parent link", () => {
        expect(() =>
            assertAppliedSyncRange(progress(), [
                block(901),
                { ...block(902), parentHash: "other:901" },
            ]),
        ).toThrow(ChainSyncConflict);
    });

    it("requires the accepted anchor when the applied prefix starts there", () => {
        const before = progress();
        before.applied = before.anchor;
        expect(() =>
            assertAppliedSyncRange(before, [block(900)]),
        ).not.toThrow();
        before.applied = block(899, "replacement");
        expect(() => assertAppliedSyncRange(before, [block(900)])).toThrow(
            ChainSyncConflict,
        );
    });

    it("rejects incomplete or malformed header evidence", () => {
        for (const candidate of [
            { ...block(901), hash: "" },
            { ...block(901), parentHash: "" },
            { ...block(901), timestamp: Number.NaN },
            { ...block(901), number: 901.5 },
        ]) {
            expect(() =>
                assertAppliedSyncRange(progress(), [candidate]),
            ).toThrow(ChainSyncConflict);
        }
    });
});

describe("monotonic validation proof position", () => {
    it("accepts block N even when sync has since applied N+1", () => {
        const current = { ...progress(), applied: block(902) };
        expect(
            canCommitValidationCheckpoint({
                candidate: checkpoint(901),
                current: current.checkpoint,
                previous: checkpoint(900),
            }),
        ).toBe(true);
    });

    it("rejects proof regression even when the order result did not change", () => {
        expect(
            canCommitValidationCheckpoint({
                candidate: checkpoint(901),
                current: progress().checkpoint,
                previous: checkpoint(902),
            }),
        ).toBe(false);
    });

    it("accepts repeated identity but rejects a different hash at that height", () => {
        const input = {
            candidate: checkpoint(901),
            current: progress().checkpoint,
            previous: checkpoint(901),
        };
        expect(canCommitValidationCheckpoint(input)).toBe(true);
        input.candidate.block = block(901, "replacement");
        expect(canCommitValidationCheckpoint(input)).toBe(false);
    });

    it("rejects in-flight proof after rollback changes revision", () => {
        expect(
            canCommitValidationCheckpoint({
                candidate: checkpoint(901),
                current: { chainId: 1, revision: 1 },
                previous: null,
            }),
        ).toBe(false);
    });

    it("allows a new-revision proof to replace an orphaned higher result", () => {
        expect(
            canCommitValidationCheckpoint({
                candidate: checkpoint(900, 1),
                current: { chainId: 1, revision: 1 },
                previous: checkpoint(902),
            }),
        ).toBe(true);
    });

    it("rejects proofs across chain or collection identity", () => {
        const input = {
            candidate: checkpoint(901),
            current: progress().checkpoint,
            previous: checkpoint(900),
        };
        expect(
            canCommitValidationCheckpoint({
                ...input,
                current: { chainId: 2, revision: 0 },
            }),
        ).toBe(false);
        expect(
            canCommitValidationCheckpoint({
                ...input,
                previous: { ...input.previous, collectionId: 2 },
            }),
        ).toBe(false);
    });
});
