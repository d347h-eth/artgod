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
    it("builds a 1024-cell root grid from chain head and global block coverage", async () => {
        const useCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver(),
            readPort({
                anyBlocks: new Set([0, 1, 2, 3, 4, 8]),
                headBlock: 15,
            }),
            { async getCurrentBlockNumber() { return 15; } },
        );

        const output = await useCase.getState({
            chainRef: "ethereum",
            collectionRef: "any",
        });

        expect(output.range).toMatchObject({
            fromBlock: 0,
            toBlock: 15,
            blockCount: 16,
            bucketSize: 1,
            gridCellCount: 1024,
            canDrillDown: false,
        });
        expect(output.grid).toHaveLength(1024);
        expect(output.grid[0]).toMatchObject({
            fromBlock: 0,
            toBlock: 0,
            blockCount: 1,
            syncedBlockCount: 1,
            state: "complete",
        });
        expect(output.grid[5]).toMatchObject({
            fromBlock: 5,
            toBlock: 5,
            syncedBlockCount: 0,
            state: "empty",
        });
        expect(output.summary.selectedRangeSyncedBlockCount).toBe(6);
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
            { async getCurrentBlockNumber() { return 3; } },
        );

        const output = await useCase.getState({
            chainRef: "ethereum",
            collectionRef: "terraforms",
            fromBlock: 0,
            toBlock: 3,
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
            },
        );

        const output = await useCase.getState({ chainRef: "ethereum" });

        expect(output.summary.headBlock).toBe(4);
        expect(output.summary.headSource).toBe("indexed");
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
