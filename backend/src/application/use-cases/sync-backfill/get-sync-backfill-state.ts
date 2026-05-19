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
    pageStartBlock?: number | null;
    bucketSize?: number | null;
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
const ROOT_PAGE_START_BLOCK = 0;

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
        const page = resolveCoveragePage(input, head.blockNumber);
        const buckets = buildGridRanges(page);
        const counts = this.syncBackfillReadPort.countSyncedBlocksByRange(
            chain.publicChainId,
            context,
            buckets,
        );
        const grid = counts.map((count, index) =>
            mapGridCell(index, count, page.bucketSize),
        );
        const selectedRangeSyncedBlockCount =
            this.syncBackfillReadPort.countSyncedBlocksInRange(
                chain.publicChainId,
                context,
                page,
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
                fromBlock: page.fromBlock,
                toBlock: page.toBlock,
                blockCount: countBlocks(page),
                bucketSize: page.bucketSize,
                gridCellCount: page.gridCellCount,
                canDrillDown: page.bucketSize > 1,
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

function resolveCoveragePage(
    input: Pick<GetSyncBackfillStateInput, "pageStartBlock" | "bucketSize">,
    headBlock: number,
): SyncBackfillCoveragePage {
    const hasPageStart =
        input.pageStartBlock !== null && input.pageStartBlock !== undefined;
    const hasBucketSize =
        input.bucketSize !== null && input.bucketSize !== undefined;
    const rootBucketSize = resolveRootBucketSize(headBlock);

    if (!hasPageStart && !hasBucketSize) {
        return {
            fromBlock: ROOT_PAGE_START_BLOCK,
            toBlock: headBlock,
            bucketSize: rootBucketSize,
            gridCellCount: countRootGridCells(headBlock, rootBucketSize),
        };
    }
    if (hasPageStart !== hasBucketSize) {
        throw new ReadModelBadRequestError(
            "page_start and bucket_size must be provided together",
        );
    }

    const pageStartBlock = input.pageStartBlock as number;
    const bucketSize = input.bucketSize as number;
    assertBlockNumber(pageStartBlock, "page_start");
    assertBucketSize(bucketSize, rootBucketSize);
    if (pageStartBlock > headBlock) {
        throw new ReadModelBadRequestError("page_start must be <= head block");
    }

    const pageSpan = resolvePageSpan(bucketSize);
    if (pageStartBlock % pageSpan !== 0) {
        throw new ReadModelBadRequestError(
            "page_start must align to bucket_size",
        );
    }

    return {
        fromBlock: pageStartBlock,
        toBlock: Math.min(pageStartBlock + pageSpan - 1, headBlock),
        bucketSize,
        gridCellCount: SYNC_BACKFILL_GRID_CELL_COUNT,
    };
}

type SyncBackfillCoveragePage = SyncBackfillCoverageRange & {
    bucketSize: number;
    gridCellCount: number;
};

function assertBlockNumber(value: number, field: string): void {
    if (!Number.isInteger(value) || value < GENESIS_BLOCK) {
        throw new ReadModelBadRequestError(`${field} must be a block number`);
    }
}

function assertBucketSize(value: number, rootBucketSize: number): void {
    if (
        !Number.isInteger(value) ||
        value < 1 ||
        value > rootBucketSize ||
        !isPowerOfGridCellCount(value)
    ) {
        throw new ReadModelBadRequestError("bucket_size is invalid");
    }
}

function isPowerOfGridCellCount(value: number): boolean {
    let remaining = value;
    while (remaining > 1) {
        if (remaining % SYNC_BACKFILL_GRID_CELL_COUNT !== 0) return false;
        remaining /= SYNC_BACKFILL_GRID_CELL_COUNT;
    }
    return true;
}

function buildGridRanges(
    page: SyncBackfillCoveragePage,
): SyncBackfillCoverageRange[] {
    const ranges: SyncBackfillCoverageRange[] = [];
    for (let index = 0; index < page.gridCellCount; index += 1) {
        const start = page.fromBlock + index * page.bucketSize;
        if (start > page.toBlock) {
            ranges.push({ fromBlock: start, toBlock: start - 1 });
            continue;
        }
        ranges.push({
            fromBlock: start,
            toBlock: Math.min(page.toBlock, start + page.bucketSize - 1),
        });
    }
    return ranges;
}

function mapGridCell(
    index: number,
    count: SyncBackfillCoverageCount,
    bucketSize: number,
): SyncBackfillGridCell {
    const blockCount = countBlocks(count);
    return {
        index,
        fromBlock: count.fromBlock,
        toBlock: count.toBlock,
        blockCount,
        syncedBlockCount: count.syncedBlockCount,
        state: resolveCoverageState(blockCount, count.syncedBlockCount),
        canDrillDown: bucketSize > 1 && blockCount > 0,
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

function resolveRootBucketSize(headBlock: number): number {
    const blockCount = headBlock - GENESIS_BLOCK + 1;
    let bucketSize = 1;
    while (
        Math.ceil(blockCount / bucketSize) > SYNC_BACKFILL_GRID_CELL_COUNT
    ) {
        bucketSize *= SYNC_BACKFILL_GRID_CELL_COUNT;
    }
    return bucketSize;
}

function countRootGridCells(headBlock: number, bucketSize: number): number {
    const blockCount = headBlock - GENESIS_BLOCK + 1;
    return Math.max(1, Math.ceil(blockCount / bucketSize));
}

function resolvePageSpan(bucketSize: number): number {
    return bucketSize * SYNC_BACKFILL_GRID_CELL_COUNT;
}

function countBlocks(range: SyncBackfillCoverageRange): number {
    if (range.fromBlock > range.toBlock) return 0;
    return range.toBlock - range.fromBlock + 1;
}
