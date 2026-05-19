import { describe, expect, it } from "vitest";
import type { ChainRecord } from "@artgod/shared/types/browse";
import { GetSyncBackfillStateUseCase } from "./get-sync-backfill-state.js";
import type {
    SyncBackfillCoverageContext,
    SyncBackfillCoverageRange,
    SyncBackfillReadPort,
} from "./get-sync-backfill-state.js";

const CHAIN: ChainRecord = {
    id: 1,
    type: "evm",
    publicChainId: 1,
    slug: "ethereum",
    name: "Ethereum",
};

describe("GetSyncBackfillStateUseCase", () => {
    it("builds an organic root grid from power-of-1024 aligned ranges", async () => {
        const useCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver(),
            readPort({
                anyBlocks: new Set([0, 1_024, 1_048_576, 2_500_000]),
                headBlock: 2_500_000,
            }),
            rpcPort(2_500_000),
        );

        const output = await useCase.getState({
            chainRef: "ethereum",
            collectionRef: "any",
        });

        expect(output.range).toMatchObject({
            fromBlock: 0,
            toBlock: 2_500_000,
            blockCount: 2_500_001,
            bucketSize: 1_048_576,
            gridCellCount: 3,
            canDrillDown: true,
        });
        expect(output.grid).toHaveLength(3);
        expect(output.grid[0]).toMatchObject({
            fromBlock: 0,
            toBlock: 1_048_575,
            blockCount: 1_048_576,
            syncedBlockCount: 2,
            state: "partial",
            canDrillDown: true,
        });
        expect(output.grid[2]).toMatchObject({
            fromBlock: 2_097_152,
            toBlock: 2_500_000,
            blockCount: 402_849,
            syncedBlockCount: 1,
            state: "partial",
        });
        expect(output.summary.selectedRangeSyncedBlockCount).toBe(4);
    });

    it("builds full 1024-cell child pages with stable bucket spans", async () => {
        const useCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver(),
            readPort({
                anyBlocks: new Set([1_048_576, 1_049_600]),
                headBlock: 2_500_000,
            }),
            rpcPort(2_500_000),
        );

        const output = await useCase.getState({
            chainRef: "ethereum",
            pageStartBlock: 1_048_576,
            bucketSize: 1_024,
        });

        expect(output.range).toMatchObject({
            fromBlock: 1_048_576,
            toBlock: 2_097_151,
            blockCount: 1_048_576,
            bucketSize: 1_024,
            gridCellCount: 1_024,
            canDrillDown: true,
        });
        expect(output.grid).toHaveLength(1_024);
        expect(output.grid[0]).toMatchObject({
            fromBlock: 1_048_576,
            toBlock: 1_049_599,
            blockCount: 1_024,
            syncedBlockCount: 1,
            state: "partial",
            canDrillDown: true,
        });
        expect(output.grid[1]).toMatchObject({
            fromBlock: 1_049_600,
            toBlock: 1_050_623,
            blockCount: 1_024,
            syncedBlockCount: 1,
            state: "partial",
        });
    });

    it("keeps live-tip leaf pages stable with disabled future slots", async () => {
        const useCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver(),
            readPort({
                anyBlocks: new Set([2_499_584, 2_500_000]),
                headBlock: 2_500_000,
            }),
            rpcPort(2_500_000),
        );

        const output = await useCase.getState({
            chainRef: "ethereum",
            pageStartBlock: 2_499_584,
            bucketSize: 1,
        });

        expect(output.range).toMatchObject({
            fromBlock: 2_499_584,
            toBlock: 2_500_000,
            blockCount: 417,
            bucketSize: 1,
            gridCellCount: 1_024,
            canDrillDown: false,
        });
        expect(output.grid).toHaveLength(1_024);
        expect(output.grid[416]).toMatchObject({
            fromBlock: 2_500_000,
            toBlock: 2_500_000,
            blockCount: 1,
            syncedBlockCount: 1,
            state: "complete",
        });
        expect(output.grid[417]).toMatchObject({
            fromBlock: 2_500_001,
            toBlock: 2_500_000,
            blockCount: 0,
            syncedBlockCount: 0,
            state: "empty",
            canDrillDown: false,
        });
    });

    it("uses collection-specific coverage when a live collection is selected", async () => {
        const useCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver(),
            readPort({
                anyBlocks: new Set([0, 1, 2, 3]),
                collectionBlocks: new Map([[7, new Set([2, 3])]]),
                headBlock: 3,
            }),
            rpcPort(3),
        );

        const output = await useCase.getState({
            chainRef: "ethereum",
            collectionRef: "terraforms",
        });

        expect(output.context.selected).toBe("terraforms");
        expect(output.summary.syncedBlockCount).toBe(2);
        expect(output.grid.slice(0, 4).map((cell) => cell.state)).toEqual([
            "empty",
            "empty",
            "complete",
            "complete",
        ]);
    });

    it("falls back to indexed head when RPC head is unavailable", async () => {
        const useCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver(),
            readPort({
                anyBlocks: new Set([4]),
                headBlock: 4,
            }),
            {
                async getCurrentBlockNumber() {
                    throw new Error("rpc unavailable");
                },
                async getBlockTimestamp() {
                    return 400;
                },
            },
        );

        const output = await useCase.getState({ chainRef: "ethereum" });

        expect(output.summary.headBlock).toBe(4);
        expect(output.summary.headSource).toBe("indexed");
    });

    it("uses DB page endpoint timestamps when available", async () => {
        const useCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver(),
            readPort({
                anyBlocks: new Set([0, 4]),
                headBlock: 4,
                blockTimestamps: new Map([
                    [0, 100],
                    [4, 172],
                ]),
            }),
            rpcPort(4, new Map([[0, 10]])),
        );

        const output = await useCase.getState({ chainRef: "ethereum" });

        expect(output.range.time).toEqual({
            from: { blockNumber: 0, timestamp: 100, source: "db" },
            to: { blockNumber: 4, timestamp: 172, source: "db" },
            durationSeconds: 72,
        });
    });

    it("falls back to RPC timestamps for missing page endpoints", async () => {
        const useCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver(),
            readPort({
                anyBlocks: new Set([0, 4]),
                headBlock: 4,
                blockTimestamps: new Map([[0, 100]]),
            }),
            rpcPort(4, new Map([[4, 172]])),
        );

        const output = await useCase.getState({ chainRef: "ethereum" });

        expect(output.range.time).toEqual({
            from: { blockNumber: 0, timestamp: 100, source: "db" },
            to: { blockNumber: 4, timestamp: 172, source: "rpc" },
            durationSeconds: 72,
        });
    });
});

function chainResolver() {
    return {
        resolveChainRef() {
            return CHAIN;
        },
    };
}

function readPort(input: {
    anyBlocks: Set<number>;
    collectionBlocks?: Map<number, Set<number>>;
    headBlock: number;
    blockTimestamps?: Map<number, number>;
}): SyncBackfillReadPort {
    const collections = [
        {
            chainId: 1,
            collectionId: 7,
            slug: "terraforms",
            address: "0x1111111111111111111111111111111111111111",
            status: "live" as const,
            bootstrapAnchorBlock: 1,
            bootstrapLastSyncedBlock: null,
        },
    ];

    return {
        listLiveCollections() {
            return collections;
        },
        getHighestSyncedBlock() {
            return input.anyBlocks.size > 0 ? input.headBlock : null;
        },
        getBlockTimestamp(_chainId, blockNumber) {
            return input.blockTimestamps?.get(blockNumber) ?? null;
        },
        countSyncedBlocks(_chainId, context) {
            return selectSet(input, context).size;
        },
        countSyncedBlocksInRange(_chainId, context, range) {
            return countSetRange(selectSet(input, context), range);
        },
        countSyncedBlocksByRange(_chainId, context, ranges) {
            const source = selectSet(input, context);
            return ranges.map((range) => ({
                ...range,
                syncedBlockCount: countSetRange(source, range),
            }));
        },
    };
}

function rpcPort(
    headBlock: number,
    blockTimestamps = new Map<number, number>(),
) {
    return {
        async getCurrentBlockNumber() {
            return headBlock;
        },
        async getBlockTimestamp(blockNumber: number) {
            return blockTimestamps.get(blockNumber) ?? blockNumber;
        },
    };
}

function selectSet(
    input: {
        anyBlocks: Set<number>;
        collectionBlocks?: Map<number, Set<number>>;
    },
    context: SyncBackfillCoverageContext,
): Set<number> {
    if (context.kind === "collection") {
        return input.collectionBlocks?.get(context.collectionId) ?? new Set();
    }
    return input.anyBlocks;
}

function countSetRange(
    source: Set<number>,
    range: SyncBackfillCoverageRange,
): number {
    let count = 0;
    for (const block of source) {
        if (block >= range.fromBlock && block <= range.toBlock) {
            count += 1;
        }
    }
    return count;
}
