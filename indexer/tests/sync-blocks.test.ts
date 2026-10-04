import { describe, expect, it, vi } from "vitest";
import { fetchCanonicalSyncBlocks } from "../src/application/sync-blocks.js";
import { findCommonAncestor } from "../src/application/reorg-fork.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
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
                getBlockHash: vi.fn(
                    (_chainId: number, number: number) =>
                        stored[number] ?? null,
                ),
            },
            rpc: { getBlock: vi.fn(async (number: number) => block(number)) },
        };
    }

    it("continues across missing local history to a proven matching header", async () => {
        const h = harness({ 103: block(203).hash, 101: block(101).hash });
        expect(await findCommonAncestor(h)).toBe(101);
        expect(h.rpc.getBlock.mock.calls).toEqual([
            [103, { fresh: true }],
            [101, { fresh: true }],
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
        expect(
            h.storage.getBlockHash.mock.calls.map((call) => call[1]),
        ).toEqual([104, 103, 102, 101, 100]);
    });

    it("selects the nearest actual match", async () => {
        const h = harness({ 104: block(104).hash, 103: block(103).hash });
        expect(await findCommonAncestor(h)).toBe(104);
        expect(h.rpc.getBlock).toHaveBeenCalledTimes(1);
    });

    it("can prove genesis without reading negative block numbers", async () => {
        const h = harness({ 0: block(0).hash });
        expect(await findCommonAncestor({ ...h, startBlock: 2 })).toBe(0);
        expect(
            h.storage.getBlockHash.mock.calls.map((call) => call[1]),
        ).toEqual([1, 0]);
    });

    it("does not accept a matching hash from a wrong-height RPC response", async () => {
        const h = harness({ 104: block(104).hash });
        h.rpc.getBlock.mockResolvedValue({ ...block(104), number: 103 });
        await expect(findCommonAncestor(h)).rejects.toBeInstanceOf(
            ChainSyncConflict,
        );
    });
});
