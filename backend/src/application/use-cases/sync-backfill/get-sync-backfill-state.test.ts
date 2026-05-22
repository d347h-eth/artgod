import { describe, expect, it } from "vitest";
import type { ChainRecord } from "@artgod/shared/types/browse";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import type {
    ApmPort,
    SpanAttributes,
} from "@artgod/shared/observability/apm";
import { GetSyncBackfillStateUseCase } from "./get-sync-backfill-state.js";
import type {
    SyncBackfillCoverageContext,
    SyncBackfillCoverageRange,
    SyncBackfillReadPort,
} from "./get-sync-backfill-state.js";
import { SYNC_BACKFILL_SPAN_ATTRIBUTE } from "./sync-backfill-observability.js";

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

    it("marks the selected collection deployment block on the grid", async () => {
        const unsyncedUseCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver(),
            readPort({
                anyBlocks: new Set([0, 1, 2, 3]),
                collectionBlocks: new Map([[7, new Set([3])]]),
                deploymentBlock: 2,
                headBlock: 3,
            }),
            rpcPort(3),
        );
        const syncedUseCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver(),
            readPort({
                anyBlocks: new Set([0, 1, 2, 3]),
                collectionBlocks: new Map([[7, new Set([2, 3])]]),
                deploymentBlock: 2,
                headBlock: 3,
            }),
            rpcPort(3),
        );

        const unsynced = await unsyncedUseCase.getState({
            chainRef: "ethereum",
            collectionRef: "terraforms",
        });
        const synced = await syncedUseCase.getState({
            chainRef: "ethereum",
            collectionRef: "terraforms",
        });

        expect(unsynced.context.collections[0]?.deploymentBlock).toBe(2);
        expect(unsynced.grid[2]?.collectionDeploymentBlock).toEqual({
            blockNumber: 2,
            synced: false,
        });
        expect(synced.grid[2]?.collectionDeploymentBlock).toEqual({
            blockNumber: 2,
            synced: true,
        });
    });

    it("does not drill into collection buckets that end before deployment", async () => {
        const useCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver(),
            readPort({
                anyBlocks: new Set([0, 1_024, 2_047]),
                collectionBlocks: new Map([[7, new Set([1_024, 2_047])]]),
                deploymentBlock: 1_024,
                headBlock: 2_047,
            }),
            rpcPort(2_047),
        );

        const output = await useCase.getState({
            chainRef: "ethereum",
            collectionRef: "terraforms",
        });

        expect(output.range.bucketSize).toBe(1_024);
        expect(output.grid[0]).toMatchObject({
            fromBlock: 0,
            toBlock: 1_023,
            canDrillDown: false,
        });
        expect(output.grid[1]).toMatchObject({
            fromBlock: 1_024,
            toBlock: 2_047,
            canDrillDown: true,
        });
    });

    it("builds a range summary for an arbitrary visible bucket", async () => {
        const useCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver(),
            readPort({
                anyBlocks: new Set([1_024, 1_025, 2_047]),
                headBlock: 2_047,
                blockTimestamps: new Map([
                    [1_024, 100],
                    [2_047, 172],
                ]),
            }),
            rpcPort(2_047),
        );

        const output = await useCase.getRangeSummary({
            chainRef: "ethereum",
            fromBlock: 1_024,
            toBlock: 2_047,
        });

        expect(output.range).toEqual({
            fromBlock: 1_024,
            toBlock: 2_047,
            blockCount: 1_024,
            bucketSize: 1_024,
            syncedBlockCount: 3,
            time: {
                from: { blockNumber: 1_024, timestamp: 100, source: "db" },
                to: { blockNumber: 2_047, timestamp: 172, source: "db" },
                durationSeconds: 72,
            },
        });
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
                anyBlocks: new Set([1_024, 2_047]),
                headBlock: 2_047,
                blockTimestamps: new Map([
                    [1_024, 100],
                    [2_047, 172],
                ]),
            }),
            rpcPort(2_047, new Map([[1_024, 10]])),
        );

        const output = await useCase.getState({
            chainRef: "ethereum",
            pageStartBlock: 1_024,
            bucketSize: 1,
        });

        expect(output.range.time).toEqual({
            from: { blockNumber: 1_024, timestamp: 100, source: "db" },
            to: { blockNumber: 2_047, timestamp: 172, source: "db" },
            durationSeconds: 72,
        });
    });

    it("uses RPC for genesis timestamps when no chain override exists", async () => {
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
            rpcPort(4, new Map([[0, 0]])),
        );

        const output = await useCase.getState({ chainRef: "ethereum" });

        expect(output.range.time.from).toEqual({
            blockNumber: 0,
            timestamp: 0,
            source: "rpc",
        });
    });

    it("uses chain genesis timestamp override before indexed block metadata", async () => {
        const useCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver({
                genesisBlockNumber: 0,
                genesisBlockTimestamp: 1_438_269_973,
            }),
            readPort({
                anyBlocks: new Set([0, 4]),
                headBlock: 4,
                blockTimestamps: new Map([
                    [0, 0],
                    [4, 1_438_270_045],
                ]),
            }),
            rpcPort(4, new Map([[0, 0]])),
        );

        const output = await useCase.getState({ chainRef: "ethereum" });

        expect(output.summary.genesisBlock).toBe(0);
        expect(output.range.time).toEqual({
            from: {
                blockNumber: 0,
                timestamp: 1_438_269_973,
                source: "chain",
            },
            to: { blockNumber: 4, timestamp: 1_438_270_045, source: "db" },
            durationSeconds: 72,
        });
    });

    it("falls back to RPC timestamps for missing page endpoints", async () => {
        const useCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver(),
            readPort({
                anyBlocks: new Set([1_024, 2_047]),
                headBlock: 2_047,
                blockTimestamps: new Map([[1_024, 100]]),
            }),
            rpcPort(2_047, new Map([[2_047, 172]])),
        );

        const output = await useCase.getState({
            chainRef: "ethereum",
            pageStartBlock: 1_024,
            bucketSize: 1,
        });

        expect(output.range.time).toEqual({
            from: { blockNumber: 1_024, timestamp: 100, source: "db" },
            to: { blockNumber: 2_047, timestamp: 172, source: "rpc" },
            durationSeconds: 72,
        });
    });

    it("records APM spans around page state adapter calls", async () => {
        const apm = new CapturingApm();
        const useCase = new GetSyncBackfillStateUseCase(
            1,
            chainResolver(),
            readPort({
                anyBlocks: new Set([1_024, 1_025, 2_047]),
                headBlock: 2_047,
                blockTimestamps: new Map([[1_024, 100]]),
            }),
            rpcPort(2_047, new Map([[2_047, 172]])),
            apm,
        );

        await useCase.getState({
            chainRef: "ethereum",
            collectionRef: "any",
            pageStartBlock: 1_024,
            bucketSize: 1,
        });

        expect(apm.names()).toEqual(
            expect.arrayContaining([
                "backend.sync_backfill.state.chain",
                "backend.sync_backfill.state.blockspace_collections",
                "backend.sync_backfill.state.highest_synced_block",
                "backend.sync_backfill.rpc.current_block_number",
                "backend.sync_backfill.state.block_timestamp_db",
                "backend.sync_backfill.rpc.block_timestamp",
                "backend.sync_backfill.state.bucket_counts",
                "backend.sync_backfill.state.selected_range_count",
                "backend.sync_backfill.state.total_count",
            ]),
        );
        expect(
            apm.span("backend.sync_backfill.state.bucket_counts")
                ?.attributes,
        ).toMatchObject({
            [SYNC_BACKFILL_SPAN_ATTRIBUTE.ChainId]: 1,
            [SYNC_BACKFILL_SPAN_ATTRIBUTE.FromBlock]: 1_024,
            [SYNC_BACKFILL_SPAN_ATTRIBUTE.ToBlock]: 2_047,
            [SYNC_BACKFILL_SPAN_ATTRIBUTE.BucketSize]: 1,
            [SYNC_BACKFILL_SPAN_ATTRIBUTE.RangesCount]: 1_024,
        });
    });
});

class CapturingApm implements ApmPort {
    readonly spans: Array<{ name: string; attributes: SpanAttributes }> = [];

    async withSpan<T>(
        name: string,
        attributes: SpanAttributes,
        run: () => Promise<T>,
    ): Promise<T> {
        this.spans.push({ name, attributes });
        return run();
    }

    withSyncSpan<T>(
        name: string,
        attributes: SpanAttributes,
        run: () => T,
    ): T {
        this.spans.push({ name, attributes });
        return run();
    }

    names(): string[] {
        return this.spans.map((span) => span.name);
    }

    span(name: string): { name: string; attributes: SpanAttributes } | null {
        return this.spans.find((span) => span.name === name) ?? null;
    }
}

function chainResolver(overrides: Partial<ChainRecord> = {}) {
    return {
        resolveChainRef() {
            return { ...CHAIN, ...overrides };
        },
    };
}

function readPort(input: {
    anyBlocks: Set<number>;
    collectionBlocks?: Map<number, Set<number>>;
    deploymentBlock?: number | null;
    headBlock: number;
    blockTimestamps?: Map<number, number>;
}): SyncBackfillReadPort {
    const collections = [
        {
            chainId: 1,
            collectionId: 7,
            slug: "terraforms",
            address: "0x1111111111111111111111111111111111111111",
            status: COLLECTION_STATUS.Live,
            deploymentBlock: input.deploymentBlock ?? null,
            bootstrapAnchorBlock: 1,
            bootstrapLastSyncedBlock: null,
        },
    ];

    return {
        listBlockspaceCollections() {
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
