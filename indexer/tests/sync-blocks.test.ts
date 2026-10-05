import { describe, expect, it, vi } from "vitest";
import { fetchCanonicalSyncBlocks } from "../src/application/sync-blocks.js";
import { findCommonAncestor } from "../src/application/reorg-fork.js";
import {
    ChainSyncConflict,
    type SyncBlockHeader,
} from "../src/domain/chain-sync.js";
import type { ReorgHistorySnapshot } from "../src/domain/reorg-fork.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";

describe("canonical sync header reads", () => {
    it("bypasses cached headers and rechecks the tip after the complete range", async () => {
        const rpc = {
            getBlock: vi.fn(async (number: number) => block(number)),
        };
        expect(
            await fetchCanonicalSyncBlocks({
                rpc,
                fromBlock: 101,
                toBlock: 103,
            }),
        ).toEqual([101, 102, 103].map(block));
        expect(rpc.getBlock.mock.calls).toEqual([
            [101, { fresh: true }],
            [102, { fresh: true }],
            [103, { fresh: true }],
            [103, { fresh: true }],
        ]);
    });

    it("rejects a reorg after the range headers were fetched", async () => {
        const rpc = {
            getBlock: vi
                .fn()
                .mockResolvedValueOnce(block(101))
                .mockResolvedValueOnce({
                    ...block(101),
                    hash: block(201).hash,
                }),
        };
        await expect(
            fetchCanonicalSyncBlocks({ rpc, fromBlock: 101, toBlock: 101 }),
        ).rejects.toBeInstanceOf(ChainSyncConflict);
    });

    it("rejects headers read from different branches mid-range", async () => {
        const rpc = {
            getBlock: vi
                .fn()
                .mockResolvedValueOnce(block(101))
                .mockResolvedValueOnce({
                    ...block(102),
                    parentHash: block(201).hash,
                }),
        };
        await expect(
            fetchCanonicalSyncBlocks({ rpc, fromBlock: 101, toBlock: 102 }),
        ).rejects.toBeInstanceOf(ChainSyncConflict);
    });

    it("rejects a provider returning another height", async () => {
        const rpc = { getBlock: vi.fn(async () => block(102)) };
        await expect(
            fetchCanonicalSyncBlocks({ rpc, fromBlock: 101, toBlock: 101 }),
        ).rejects.toBeInstanceOf(ChainSyncConflict);
    });
});

describe("verified common ancestor", () => {
    function harness(stored: Record<number, string>) {
        return {
            chainId: 1,
            startBlock: 105,
            reorgDepth: 5,
            storage: {
                captureReorgHistory: vi.fn(
                    ({
                        chainId,
                        fromBlock,
                        toBlock,
                    }: {
                        chainId: number;
                        fromBlock: number;
                        toBlock: number;
                    }): ReorgHistorySnapshot => ({
                        checkpoint: { chainId, revision: 0 },
                        fromBlock,
                        toBlock,
                        headers: Object.entries(stored)
                            .map(([number, hash]) => ({
                                ...block(Number(number)),
                                hash,
                            }))
                            .filter(
                                (header) =>
                                    header.number >= fromBlock &&
                                    header.number <= toBlock,
                            ),
                    }),
                ),
            },
            rpc: { getBlock: vi.fn(async (number: number) => block(number)) },
        };
    }

    it("continues across missing local history to a proven matching header", async () => {
        const h = harness({ 103: block(203).hash, 101: block(101).hash });
        expect(await findCommonAncestor(h)).toMatchObject({
            fork: { ...block(101), chainId: 1 },
            history: {
                fromBlock: 100,
                toBlock: 105,
                checkpoint: { chainId: 1, revision: 0 },
            },
        });
        expect(h.rpc.getBlock.mock.calls).toEqual([
            [100, { fresh: true }],
            [101, { fresh: true }],
            [102, { fresh: true }],
            [103, { fresh: true }],
            [104, { fresh: true }],
            [105, { fresh: true }],
            [105, { fresh: true }],
        ]);
    });

    it("returns no ancestor when every available header disagrees", async () => {
        const h = harness({ 104: block(204).hash, 100: block(200).hash });
        expect(await findCommonAncestor(h)).toBeNull();
    });

    it("does not infer an ancestor from entirely missing local history", async () => {
        const h = harness({});
        expect(await findCommonAncestor(h)).toBeNull();
        expect(h.rpc.getBlock).not.toHaveBeenCalled();
    });

    it("does not search beyond the configured depth", async () => {
        const h = harness({ 99: block(99).hash });
        expect(await findCommonAncestor(h)).toBeNull();
        expect(h.storage.captureReorgHistory.mock.calls).toEqual([
            [{ chainId: 1, fromBlock: 100, toBlock: 105 }],
        ]);
    });

    it("selects the nearest actual match", async () => {
        const h = harness({ 104: block(104).hash, 103: block(103).hash });
        expect(await findCommonAncestor(h)).toMatchObject({
            fork: { ...block(104), chainId: 1 },
        });
        expect(h.rpc.getBlock).toHaveBeenCalledTimes(7);
    });

    it("rejects a matching island above an earlier divergent stored header", async () => {
        const h = harness({
            104: block(104).hash,
            103: block(203).hash,
            102: block(102).hash,
        });
        expect(await findCommonAncestor(h)).toMatchObject({
            fork: { ...block(102), chainId: 1 },
        });
    });

    it("uses stored parent identity to reject a matching island over a missing divergent header", async () => {
        const h = harness({});
        const headers: SyncBlockHeader[] = [
            block(102),
            block(104),
            {
                ...block(105),
                hash: block(205).hash,
                parentHash: block(204).hash,
            },
        ];
        h.storage.captureReorgHistory.mockReturnValue({
            checkpoint: { chainId: 1, revision: 0 },
            fromBlock: 100,
            toBlock: 105,
            headers,
        });
        expect(await findCommonAncestor(h)).toMatchObject({
            fork: { ...block(102), chainId: 1 },
        });
    });

    it("keeps recovery pending when a stored parent reveals divergence beyond the depth bound", async () => {
        const h = harness({});
        h.storage.captureReorgHistory.mockReturnValue({
            checkpoint: { chainId: 1, revision: 0 },
            fromBlock: 100,
            toBlock: 105,
            headers: [
                block(100),
                {
                    ...block(101),
                    hash: block(201).hash,
                    parentHash: block(200).hash,
                },
            ],
        });
        expect(await findCommonAncestor(h)).toBeNull();
    });

    it("rejects a changing or mixed RPC chain while proving the entire window", async () => {
        const h = harness({ 104: block(104).hash });
        h.rpc.getBlock.mockImplementation(async (number) =>
            number === 103
                ? { ...block(number), parentHash: block(202).hash }
                : block(number),
        );
        await expect(findCommonAncestor(h)).rejects.toBeInstanceOf(
            ChainSyncConflict,
        );
    });

    it("can prove genesis without reading negative block numbers", async () => {
        const h = harness({ 0: block(0).hash });
        expect(await findCommonAncestor({ ...h, startBlock: 2 })).toMatchObject(
            {
                fork: { ...block(0), chainId: 1 },
            },
        );
        expect(h.storage.captureReorgHistory.mock.calls).toEqual([
            [{ chainId: 1, fromBlock: 0, toBlock: 2 }],
        ]);
    });

    it("does not accept a matching hash from a wrong-height RPC response", async () => {
        const h = harness({ 104: block(104).hash });
        h.rpc.getBlock.mockResolvedValue({ ...block(104), number: 103 });
        await expect(findCommonAncestor(h)).rejects.toBeInstanceOf(
            ChainSyncConflict,
        );
    });
});
