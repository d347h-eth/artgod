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
    function localBranch(from = 100, to = 105, fork = 103): SyncBlockHeader[] {
        return Array.from({ length: to - from + 1 }, (_, offset) => {
            const number = from + offset;
            return number < fork
                ? block(number)
                : {
                      ...block(number),
                      hash: block(number + 1000).hash,
                      parentHash: block(
                          number > fork ? number + 999 : number - 1,
                      ).hash,
                  };
        });
    }
    function harness(headers = localBranch(), fromBlock = 100, toBlock = 105) {
        return {
            chainId: 1,
            startBlock: toBlock,
            reorgDepth: 5,
            storage: {
                captureReorgHistory: vi.fn(
                    (): ReorgHistorySnapshot => ({
                        checkpoint: { chainId: 1, revision: 0 },
                        fromBlock,
                        toBlock,
                        headers,
                    }),
                ),
            },
            rpc: { getBlock: vi.fn(async (number: number) => block(number)) },
        };
    }

    it("proves the nearest ancestor from connected accepted history and independent fresh RPC", async () => {
        const h = harness();
        expect(await findCommonAncestor(h)).toMatchObject({
            fork: { ...block(102), chainId: 1 },
            history: { fromBlock: 100, toBlock: 105 },
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

    it.each(
        [
            [],
            [block(100), block(102), block(103), block(104), block(105)],
            [
                block(100),
                block(101),
                { ...block(102), parentHash: block(500).hash },
                block(103),
                block(104),
                block(105),
            ],
        ].map((headers) => ({ headers })),
    )(
        "rejects missing or disconnected accepted lineage before RPC: %j",
        async ({ headers }) => {
            const h = harness(headers);
            await expect(findCommonAncestor(h)).rejects.toBeInstanceOf(
                ChainSyncConflict,
            );
            expect(h.rpc.getBlock).not.toHaveBeenCalled();
        },
    );

    it("does not search outside supported depth when its entire window differs", async () => {
        const h = harness(localBranch(100, 105, 99));
        expect(await findCommonAncestor(h)).toBeNull();
        expect(h.storage.captureReorgHistory.mock.calls).toEqual([
            [{ chainId: 1, fromBlock: 100, toBlock: 105 }],
        ]);
    });

    it("acquires only the window clamped to the accepted base by storage", async () => {
        const h = harness(localBranch(103, 105, 105), 103, 105);
        expect(await findCommonAncestor(h)).toMatchObject({
            fork: { ...block(104), chainId: 1 },
        });
        expect(h.rpc.getBlock.mock.calls).toEqual([
            [103, { fresh: true }],
            [104, { fresh: true }],
            [105, { fresh: true }],
            [105, { fresh: true }],
        ]);
    });

    it("cannot prove an ancestor when the accepted base itself is replaced", async () => {
        const h = harness(localBranch(105, 105, 105), 105, 105);
        expect(await findCommonAncestor(h)).toBeNull();
    });

    it("rejects changing or mixed RPC lineage", async () => {
        const h = harness();
        h.rpc.getBlock.mockImplementation(async (number) =>
            number === 103
                ? { ...block(number), parentHash: block(202).hash }
                : block(number),
        );
        await expect(findCommonAncestor(h)).rejects.toBeInstanceOf(
            ChainSyncConflict,
        );
    });

    it("can prove genesis without reading negative heights", async () => {
        const h = harness(localBranch(0, 2, 1), 0, 2);
        expect(await findCommonAncestor(h)).toMatchObject({
            fork: { ...block(0), chainId: 1 },
        });
        expect(h.storage.captureReorgHistory.mock.calls).toEqual([
            [{ chainId: 1, fromBlock: 0, toBlock: 2 }],
        ]);
    });

    it("does not accept a matching hash from a wrong-height response", async () => {
        const h = harness();
        h.rpc.getBlock.mockResolvedValue({ ...block(100), number: 99 });
        await expect(findCommonAncestor(h)).rejects.toBeInstanceOf(
            ChainSyncConflict,
        );
    });
});
