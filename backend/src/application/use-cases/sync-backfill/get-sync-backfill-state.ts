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

// Identifies where a visible page endpoint timestamp was resolved.
export type SyncBackfillBlockTimestampSource =
    | "chain"
    | "db"
    | "rpc"
    | "unavailable";

// Carries the timestamp anchor for one visible page endpoint block.
export type SyncBackfillBlockTimestamp = {
    blockNumber: number;
    timestamp: number | null;
    source: SyncBackfillBlockTimestampSource;
};

export type GetSyncBackfillStateInput = {
    chainRef: string;
    collectionRef?: string | null;
    pageStartBlock?: number | null;
    bucketSize?: number | null;
};

export type GetSyncBackfillRangeSummaryInput = {
    chainRef: string;
    collectionRef?: string | null;
    fromBlock: number;
    toBlock: number;
};

export type SyncBackfillRangeSummary = {
    fromBlock: number;
    toBlock: number;
    blockCount: number;
    bucketSize: number;
    syncedBlockCount: number;
    time: {
        from: SyncBackfillBlockTimestamp;
        to: SyncBackfillBlockTimestamp;
        durationSeconds: number | null;
    };
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
        time: {
            from: SyncBackfillBlockTimestamp;
            to: SyncBackfillBlockTimestamp;
            durationSeconds: number | null;
        };
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

export type GetSyncBackfillRangeSummaryOutput = {
    chain: ChainRecord;
    context: {
        selected: typeof SYNC_BACKFILL_CONTEXT_ANY | string;
    };
    range: SyncBackfillRangeSummary;
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
    getBlockTimestamp(chainId: number, blockNumber: number): number | null;
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
    getBlockTimestamp(blockNumber: number): Promise<number>;
};

const DEFAULT_GENESIS_BLOCK = 0;

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
        const context = resolveCoverageContext(
            input.collectionRef,
            collections,
        );
        const highestSyncedBlock =
            this.syncBackfillReadPort.getHighestSyncedBlock(
                chain.publicChainId,
            );
        const genesisBlock = resolveGenesisBlockNumber(chain);
        const head = await this.resolveHeadBlock(
            highestSyncedBlock,
            genesisBlock,
        );
        const page = resolveCoveragePage(input, head.blockNumber, genesisBlock);
        const pageTime = await this.resolvePageTime(
            chain.publicChainId,
            chain,
            page,
            genesisBlock,
        );
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
                time: pageTime,
            },
            summary: {
                genesisBlock,
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

    async getRangeSummary(
        input: GetSyncBackfillRangeSummaryInput,
    ): Promise<GetSyncBackfillRangeSummaryOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collections = this.syncBackfillReadPort.listLiveCollections(
            chain.publicChainId,
        );
        const context = resolveCoverageContext(
            input.collectionRef,
            collections,
        );
        const highestSyncedBlock =
            this.syncBackfillReadPort.getHighestSyncedBlock(
                chain.publicChainId,
            );
        const genesisBlock = resolveGenesisBlockNumber(chain);
        const head = await this.resolveHeadBlock(
            highestSyncedBlock,
            genesisBlock,
        );
        const range = resolveExplicitCoverageRange(
            input,
            head.blockNumber,
            genesisBlock,
        );
        const time = await this.resolvePageTime(
            chain.publicChainId,
            chain,
            range,
            genesisBlock,
        );
        const blockCount = countBlocks(range);

        return {
            chain,
            context: {
                selected:
                    context.kind === "collection"
                        ? context.slug
                        : SYNC_BACKFILL_CONTEXT_ANY,
            },
            range: {
                ...range,
                blockCount,
                bucketSize: blockCount,
                syncedBlockCount:
                    this.syncBackfillReadPort.countSyncedBlocksInRange(
                        chain.publicChainId,
                        context,
                        range,
                    ),
                time,
            },
        };
    }

    private async resolveHeadBlock(
        highestSyncedBlock: number | null,
        genesisBlock: number,
    ): Promise<{ blockNumber: number; source: "rpc" | "indexed" }> {
        try {
            const current = await this.chainHeadPort.getCurrentBlockNumber();
            if (Number.isInteger(current) && current >= genesisBlock) {
                return { blockNumber: current, source: "rpc" };
            }
        } catch {}

        return {
            blockNumber: Math.max(genesisBlock, highestSyncedBlock ?? 0),
            source: "indexed",
        };
    }

    private async resolvePageTime(
        chainId: number,
        chain: ChainRecord,
        page: SyncBackfillCoverageRange,
        genesisBlock: number,
    ): Promise<{
        from: SyncBackfillBlockTimestamp;
        to: SyncBackfillBlockTimestamp;
        durationSeconds: number | null;
    }> {
        const from = await this.resolveBlockTimestamp(
            chainId,
            chain,
            page.fromBlock,
            genesisBlock,
        );
        const to =
            page.toBlock === page.fromBlock
                ? from
                : await this.resolveBlockTimestamp(
                      chainId,
                      chain,
                      page.toBlock,
                      genesisBlock,
                  );
        return {
            from,
            to,
            durationSeconds: resolveDurationSeconds(from, to),
        };
    }

    private async resolveBlockTimestamp(
        chainId: number,
        chain: ChainRecord,
        blockNumber: number,
        genesisBlock: number,
    ): Promise<SyncBackfillBlockTimestamp> {
        const genesisTimestamp = resolveGenesisBlockTimestamp(chain);
        const isGenesisBlock = blockNumber === genesisBlock;
        if (isGenesisBlock && genesisTimestamp !== null) {
            return {
                blockNumber,
                timestamp: genesisTimestamp,
                source: "chain",
            };
        }
        if (isGenesisBlock) {
            return this.resolveRpcBlockTimestamp(blockNumber);
        }

        // Prefer indexed block metadata so time labels match local sync state.
        const localTimestamp = this.syncBackfillReadPort.getBlockTimestamp(
            chainId,
            blockNumber,
        );
        if (
            localTimestamp !== null &&
            Number.isInteger(localTimestamp) &&
            localTimestamp >= 0
        ) {
            return {
                blockNumber,
                timestamp: localTimestamp,
                source: "db",
            };
        }

        return this.resolveRpcBlockTimestamp(blockNumber);
    }

    private async resolveRpcBlockTimestamp(
        blockNumber: number,
    ): Promise<SyncBackfillBlockTimestamp> {
        try {
            // Read JSON-RPC timestamps for explicit chain endpoints or DB misses.
            const rpcTimestamp =
                await this.chainHeadPort.getBlockTimestamp(blockNumber);
            if (Number.isInteger(rpcTimestamp) && rpcTimestamp >= 0) {
                return {
                    blockNumber,
                    timestamp: rpcTimestamp,
                    source: "rpc",
                };
            }
        } catch {}

        return {
            blockNumber,
            timestamp: null,
            source: "unavailable",
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
    genesisBlock: number,
): SyncBackfillCoveragePage {
    const hasPageStart =
        input.pageStartBlock !== null && input.pageStartBlock !== undefined;
    const hasBucketSize =
        input.bucketSize !== null && input.bucketSize !== undefined;
    const rootBucketSize = resolveRootBucketSize(headBlock, genesisBlock);

    if (!hasPageStart && !hasBucketSize) {
        return {
            fromBlock: genesisBlock,
            toBlock: headBlock,
            bucketSize: rootBucketSize,
            gridCellCount: countRootGridCells(
                headBlock,
                genesisBlock,
                rootBucketSize,
            ),
        };
    }
    if (hasPageStart !== hasBucketSize) {
        throw new ReadModelBadRequestError(
            "page_start and bucket_size must be provided together",
        );
    }

    const pageStartBlock = input.pageStartBlock as number;
    const bucketSize = input.bucketSize as number;
    assertBlockNumber(pageStartBlock, "page_start", genesisBlock);
    assertBucketSize(bucketSize, rootBucketSize);
    if (pageStartBlock > headBlock) {
        throw new ReadModelBadRequestError("page_start must be <= head block");
    }

    const pageSpan = resolvePageSpan(bucketSize);
    if ((pageStartBlock - genesisBlock) % pageSpan !== 0) {
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

function resolveExplicitCoverageRange(
    input: Pick<GetSyncBackfillRangeSummaryInput, "fromBlock" | "toBlock">,
    headBlock: number,
    genesisBlock: number,
): SyncBackfillCoverageRange {
    assertBlockNumber(input.fromBlock, "from_block", genesisBlock);
    assertBlockNumber(input.toBlock, "to_block", genesisBlock);
    if (input.fromBlock > input.toBlock) {
        throw new ReadModelBadRequestError("from_block must be <= to_block");
    }
    if (input.toBlock > headBlock) {
        throw new ReadModelBadRequestError("to_block must be <= head block");
    }
    return {
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
    };
}

type SyncBackfillCoveragePage = SyncBackfillCoverageRange & {
    bucketSize: number;
    gridCellCount: number;
};

function assertBlockNumber(
    value: number,
    field: string,
    genesisBlock: number,
): void {
    if (!Number.isInteger(value) || value < genesisBlock) {
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

function resolveRootBucketSize(
    headBlock: number,
    genesisBlock: number,
): number {
    const blockCount = headBlock - genesisBlock + 1;
    let bucketSize = 1;
    while (Math.ceil(blockCount / bucketSize) > SYNC_BACKFILL_GRID_CELL_COUNT) {
        bucketSize *= SYNC_BACKFILL_GRID_CELL_COUNT;
    }
    return bucketSize;
}

function countRootGridCells(
    headBlock: number,
    genesisBlock: number,
    bucketSize: number,
): number {
    const blockCount = headBlock - genesisBlock + 1;
    return Math.max(1, Math.ceil(blockCount / bucketSize));
}

function resolvePageSpan(bucketSize: number): number {
    return bucketSize * SYNC_BACKFILL_GRID_CELL_COUNT;
}

function countBlocks(range: SyncBackfillCoverageRange): number {
    if (range.fromBlock > range.toBlock) return 0;
    return range.toBlock - range.fromBlock + 1;
}

function resolveDurationSeconds(
    from: SyncBackfillBlockTimestamp,
    to: SyncBackfillBlockTimestamp,
): number | null {
    if (from.timestamp === null || to.timestamp === null) return null;
    return Math.max(0, to.timestamp - from.timestamp);
}

function resolveGenesisBlockNumber(chain: ChainRecord): number {
    const value = chain.genesisBlockNumber;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
    }
    return DEFAULT_GENESIS_BLOCK;
}

function resolveGenesisBlockTimestamp(chain: ChainRecord): number | null {
    const value = chain.genesisBlockTimestamp;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value;
    }
    return null;
}
