import {
    SYNC_BACKFILL_CONTEXT_ANY,
    SYNC_BACKFILL_GRID_CELL_COUNT,
} from "@artgod/shared/config/sync-backfill";
import type { ChainRecord } from "@artgod/shared/types/browse";
import { normalizeSlugRef } from "@artgod/shared/utils/ref-resolver";
import {
    ReadModelBadRequestError,
    ReadModelNotFoundError,
} from "@artgod/shared/read-models/errors";

export type SyncBackfillCoverageState = "empty" | "partial" | "complete";

export type SyncBackfillCollectionOption = {
    chainId: number;
    collectionId: number;
    slug: string;
    address: string;
    status: "live";
    bootstrapAnchorBlock: number | null;
    bootstrapLastSyncedBlock: number | null;
};

export type SyncBackfillGridCell = {
    index: number;
    fromBlock: number;
    toBlock: number;
    blockCount: number;
    syncedBlockCount: number;
    state: SyncBackfillCoverageState;
    canDrillDown: boolean;
};

export type GetSyncBackfillStateInput = {
    chainRef: string;
    collectionRef?: string | null;
    fromBlock?: number | null;
    toBlock?: number | null;
};

export type GetSyncBackfillStateOutput = {
    chain: ChainRecord;
    context: {
        selected: typeof SYNC_BACKFILL_CONTEXT_ANY | string;
        collections: SyncBackfillCollectionOption[];
    };
    range: {
        fromBlock: number;
        toBlock: number;
        blockCount: number;
        bucketSize: number;
        gridCellCount: number;
        canDrillDown: boolean;
    };
    summary: {
        genesisBlock: number;
        headBlock: number;
        headSource: "rpc" | "indexed";
        highestSyncedBlock: number | null;
        syncedBlockCount: number;
        selectedRangeSyncedBlockCount: number;
    };
    grid: SyncBackfillGridCell[];
};

export type SyncBackfillCoverageContext =
    | { kind: "any" }
    | { kind: "collection"; collectionId: number; slug: string };

export type SyncBackfillCoverageRange = {
    fromBlock: number;
    toBlock: number;
};

export type SyncBackfillCoverageCount = SyncBackfillCoverageRange & {
    syncedBlockCount: number;
};

type ChainRefResolverPort = {
    resolveChainRef(
        chainRef: string | undefined,
        defaultPublicChainId: number,
    ): ChainRecord;
};

export type SyncBackfillReadPort = {
    listLiveCollections(chainId: number): SyncBackfillCollectionOption[];
    getHighestSyncedBlock(chainId: number): number | null;
    countSyncedBlocks(
        chainId: number,
        context: SyncBackfillCoverageContext,
    ): number;
    countSyncedBlocksInRange(
        chainId: number,
        context: SyncBackfillCoverageContext,
        range: SyncBackfillCoverageRange,
    ): number;
    countSyncedBlocksByRange(
        chainId: number,
        context: SyncBackfillCoverageContext,
        ranges: SyncBackfillCoverageRange[],
    ): SyncBackfillCoverageCount[];
};

type ChainHeadPort = {
    getCurrentBlockNumber(): Promise<number>;
};

const GENESIS_BLOCK = 0;

export class GetSyncBackfillStateUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly syncBackfillReadPort: SyncBackfillReadPort,
        private readonly chainHeadPort: ChainHeadPort,
    ) {}

    async getState(
        input: GetSyncBackfillStateInput,
    ): Promise<GetSyncBackfillStateOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collections = this.syncBackfillReadPort.listLiveCollections(
            chain.publicChainId,
        );
        const context = resolveCoverageContext(input.collectionRef, collections);
        const highestSyncedBlock =
            this.syncBackfillReadPort.getHighestSyncedBlock(
                chain.publicChainId,
            );
        const head = await this.resolveHeadBlock(highestSyncedBlock);
        const range = normalizeRange(input, head.blockNumber);
        const buckets = buildGridRanges(range.fromBlock, range.toBlock);
        const counts = this.syncBackfillReadPort.countSyncedBlocksByRange(
            chain.publicChainId,
            context,
            buckets,
        );
        const grid = counts.map((count, index) => mapGridCell(index, count));
        const selectedRangeSyncedBlockCount =
            this.syncBackfillReadPort.countSyncedBlocksInRange(
                chain.publicChainId,
                context,
                range,
            );

        return {
            chain,
            context: {
                selected:
                    context.kind === "collection"
                        ? context.slug
                        : SYNC_BACKFILL_CONTEXT_ANY,
                collections,
            },
            range: {
                ...range,
                blockCount: countBlocks(range),
                bucketSize: resolveBucketSize(range),
                gridCellCount: SYNC_BACKFILL_GRID_CELL_COUNT,
                canDrillDown: resolveBucketSize(range) > 1,
            },
            summary: {
                genesisBlock: GENESIS_BLOCK,
                headBlock: head.blockNumber,
                headSource: head.source,
                highestSyncedBlock,
                syncedBlockCount: this.syncBackfillReadPort.countSyncedBlocks(
                    chain.publicChainId,
                    context,
                ),
                selectedRangeSyncedBlockCount,
            },
            grid,
        };
    }

    private async resolveHeadBlock(
        highestSyncedBlock: number | null,
    ): Promise<{ blockNumber: number; source: "rpc" | "indexed" }> {
        try {
            const current = await this.chainHeadPort.getCurrentBlockNumber();
            if (Number.isInteger(current) && current >= GENESIS_BLOCK) {
                return { blockNumber: current, source: "rpc" };
            }
        } catch {}

        return {
            blockNumber: Math.max(GENESIS_BLOCK, highestSyncedBlock ?? 0),
            source: "indexed",
        };
    }
}

function resolveCoverageContext(
    collectionRef: string | null | undefined,
    collections: SyncBackfillCollectionOption[],
): SyncBackfillCoverageContext {
    const normalized =
        collectionRef && collectionRef.trim()
            ? normalizeSlugRef(collectionRef)
            : SYNC_BACKFILL_CONTEXT_ANY;
    if (normalized === SYNC_BACKFILL_CONTEXT_ANY) {
        return { kind: "any" };
    }

    const collection = collections.find(
        (candidate) => candidate.slug === normalized,
    );
    if (!collection) {
        throw new ReadModelNotFoundError("Unknown live collection");
    }
    return {
        kind: "collection",
        collectionId: collection.collectionId,
        slug: collection.slug,
    };
}

function normalizeRange(
    input: Pick<GetSyncBackfillStateInput, "fromBlock" | "toBlock">,
    headBlock: number,
): SyncBackfillCoverageRange {
    const fromBlock =
        input.fromBlock === null || input.fromBlock === undefined
            ? GENESIS_BLOCK
            : input.fromBlock;
    const toBlock =
        input.toBlock === null || input.toBlock === undefined
            ? headBlock
            : input.toBlock;

    assertBlockNumber(fromBlock, "from_block");
    assertBlockNumber(toBlock, "to_block");
    if (fromBlock > toBlock) {
        throw new ReadModelBadRequestError("from_block must be <= to_block");
    }

    return {
        fromBlock: Math.max(GENESIS_BLOCK, Math.min(fromBlock, headBlock)),
        toBlock: Math.max(GENESIS_BLOCK, Math.min(toBlock, headBlock)),
    };
}

function assertBlockNumber(value: number, field: string): void {
    if (!Number.isInteger(value) || value < GENESIS_BLOCK) {
        throw new ReadModelBadRequestError(`${field} must be a block number`);
    }
}

function buildGridRanges(
    fromBlock: number,
    toBlock: number,
): SyncBackfillCoverageRange[] {
    const bucketSize = resolveBucketSize({ fromBlock, toBlock });
    const ranges: SyncBackfillCoverageRange[] = [];
    for (let index = 0; index < SYNC_BACKFILL_GRID_CELL_COUNT; index += 1) {
        const start = fromBlock + index * bucketSize;
        if (start > toBlock) {
            ranges.push({ fromBlock: toBlock + 1, toBlock });
            continue;
        }
        ranges.push({
            fromBlock: start,
            toBlock: Math.min(toBlock, start + bucketSize - 1),
        });
    }
    return ranges;
}

function mapGridCell(
    index: number,
    count: SyncBackfillCoverageCount,
): SyncBackfillGridCell {
    const blockCount = countBlocks(count);
    return {
        index,
        fromBlock: count.fromBlock,
        toBlock: count.toBlock,
        blockCount,
        syncedBlockCount: count.syncedBlockCount,
        state: resolveCoverageState(blockCount, count.syncedBlockCount),
        canDrillDown: blockCount > 1,
    };
}

function resolveCoverageState(
    blockCount: number,
    syncedBlockCount: number,
): SyncBackfillCoverageState {
    if (blockCount <= 0 || syncedBlockCount <= 0) return "empty";
    if (syncedBlockCount >= blockCount) return "complete";
    return "partial";
}

function resolveBucketSize(range: SyncBackfillCoverageRange): number {
    return Math.max(
        1,
        Math.ceil(countBlocks(range) / SYNC_BACKFILL_GRID_CELL_COUNT),
    );
}

function countBlocks(range: SyncBackfillCoverageRange): number {
    if (range.fromBlock > range.toBlock) return 0;
    return range.toBlock - range.fromBlock + 1;
}
