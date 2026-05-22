import {
    BLOCKSPACE_CONTEXT_ANY,
    BLOCKSPACE_GRID_CELL_COUNT,
} from "@artgod/shared/config/blockspace";
import type {
    ChainRecord,
    CollectionStatus,
} from "@artgod/shared/types/browse";
import { normalizeSlugRef } from "@artgod/shared/utils/ref-resolver";
import {
    ReadModelBadRequestError,
    ReadModelNotFoundError,
} from "@artgod/shared/read-models/errors";
import {
    NOOP_APM,
    type ApmPort,
} from "@artgod/shared/observability/apm";
import {
    SYNC_BACKFILL_SPAN_ATTRIBUTE,
    syncBackfillContextSpanAttributes,
    syncBackfillRangeSpanAttributes,
} from "./sync-backfill-observability.js";

export type SyncBackfillCoverageState = "empty" | "partial" | "complete";

export type SyncBackfillCollectionOption = {
    chainId: number;
    collectionId: number;
    slug: string;
    address: string;
    status: CollectionStatus;
    deploymentBlock: number | null;
    bootstrapAnchorBlock: number | null;
    bootstrapLastSyncedBlock: number | null;
};

export type SyncBackfillGridCellDeploymentMarker = {
    blockNumber: number;
    synced: boolean;
};

export type SyncBackfillGridCell = {
    index: number;
    fromBlock: number;
    toBlock: number;
    blockCount: number;
    syncedBlockCount: number;
    state: SyncBackfillCoverageState;
    canDrillDown: boolean;
    collectionDeploymentBlock: SyncBackfillGridCellDeploymentMarker | null;
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
    collectionOptions?: "all" | "selected";
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
        selected: typeof BLOCKSPACE_CONTEXT_ANY | string;
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
        selected: typeof BLOCKSPACE_CONTEXT_ANY | string;
    };
    range: SyncBackfillRangeSummary;
};

export type SyncBackfillCoverageContext =
    | { kind: "any" }
    | {
          kind: "collection";
          collectionId: number;
          slug: string;
          deploymentBlock: number | null;
      };

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
    listBlockspaceCollections(chainId: number): SyncBackfillCollectionOption[];
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
        private readonly apm: ApmPort = NOOP_APM,
    ) {}

    async getState(
        input: GetSyncBackfillStateInput,
    ): Promise<GetSyncBackfillStateOutput> {
        // Resolve the requested chain before reading sync coverage from adapters.
        const chain = this.apm.withSyncSpan(
            "backend.sync_backfill.state.chain",
            requestSpanAttributes(input),
            () =>
                this.chainRefResolverPort.resolveChainRef(
                    input.chainRef,
                    this.defaultChainId,
                ),
        );
        const chainAttributes = {
            [SYNC_BACKFILL_SPAN_ATTRIBUTE.ChainId]: chain.publicChainId,
            ...requestSpanAttributes(input),
        };
        // Load collection options so collection-scoped coverage can be resolved by slug.
        const collections = this.apm.withSyncSpan(
            "backend.sync_backfill.state.blockspace_collections",
            chainAttributes,
            () =>
                this.syncBackfillReadPort.listBlockspaceCollections(
                    chain.publicChainId,
                ),
        );
        const context = resolveCoverageContext(
            input.collectionRef,
            collections,
        );
        const contextAttributes = {
            ...chainAttributes,
            ...syncBackfillContextSpanAttributes(context),
        };
        // Read the local sync tip so the page can still render when RPC head is unavailable.
        const highestSyncedBlock = this.apm.withSyncSpan(
            "backend.sync_backfill.state.highest_synced_block",
            contextAttributes,
            () =>
                this.syncBackfillReadPort.getHighestSyncedBlock(
                    chain.publicChainId,
                ),
        );
        const genesisBlock = resolveGenesisBlockNumber(chain);
        const head = await this.resolveHeadBlock(
            chain.publicChainId,
            highestSyncedBlock,
            genesisBlock,
        );
        const page = resolveCoveragePage(input, head.blockNumber, genesisBlock);
        // Start timestamp resolution before local counts so RPC latency can overlap SQLite reads.
        const pageTimePromise = this.resolvePageTime(
            chain.publicChainId,
            chain,
            page,
            genesisBlock,
        );
        const buckets = buildGridRanges(page);
        const pageAttributes = {
            ...contextAttributes,
            ...syncBackfillRangeSpanAttributes(page),
            [SYNC_BACKFILL_SPAN_ATTRIBUTE.BucketSize]: page.bucketSize,
        };
        // Count each visible bucket with the blockspace read adapter.
        const counts = this.apm.withSyncSpan(
            "backend.sync_backfill.state.bucket_counts",
            {
                ...pageAttributes,
                [SYNC_BACKFILL_SPAN_ATTRIBUTE.RangesCount]: buckets.length,
            },
            () =>
                this.syncBackfillReadPort.countSyncedBlocksByRange(
                    chain.publicChainId,
                    context,
                    buckets,
                ),
        );
        const deploymentMarker = this.apm.withSyncSpan(
            "backend.sync_backfill.state.deployment_marker",
            pageAttributes,
            () =>
                resolveCollectionDeploymentMarker(
                    chain.publicChainId,
                    context,
                    page,
                    this.syncBackfillReadPort,
                ),
        );
        const grid = counts.map((count, index) =>
            mapGridCell(
                index,
                count,
                page.bucketSize,
                deploymentMarker,
                resolveDrillDownFloorBlock(context),
            ),
        );
        // Derive the selected page count from already-read bucket counts.
        const selectedRangeSyncedBlockCount = this.apm.withSyncSpan(
            "backend.sync_backfill.state.selected_range_count",
            pageAttributes,
            () => sumSyncedBlockCounts(counts),
        );
        const syncedBlockCount = pageCoversWholeChain(
            page,
            genesisBlock,
            head.blockNumber,
        )
            ? this.apm.withSyncSpan(
                  "backend.sync_backfill.state.total_count",
                  contextAttributes,
                  () => selectedRangeSyncedBlockCount,
              )
            : this.apm.withSyncSpan(
                  "backend.sync_backfill.state.total_count",
                  contextAttributes,
                  () =>
                      this.syncBackfillReadPort.countSyncedBlocks(
                          chain.publicChainId,
                          context,
                      ),
              );
        const pageTime = await pageTimePromise;

        return {
            chain,
            context: {
                selected:
                    context.kind === "collection"
                        ? context.slug
                        : BLOCKSPACE_CONTEXT_ANY,
                collections: visibleContextCollections(
                    collections,
                    context,
                    input.collectionOptions ?? "all",
                ),
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
                syncedBlockCount,
                selectedRangeSyncedBlockCount,
            },
            grid,
        };
    }

    async getRangeSummary(
        input: GetSyncBackfillRangeSummaryInput,
    ): Promise<GetSyncBackfillRangeSummaryOutput> {
        // Resolve the chain before range-summary reads cross adapter boundaries.
        const chain = this.apm.withSyncSpan(
            "backend.sync_backfill.range.chain",
            explicitRangeRequestSpanAttributes(input),
            () =>
                this.chainRefResolverPort.resolveChainRef(
                    input.chainRef,
                    this.defaultChainId,
                ),
        );
        const chainAttributes = {
            [SYNC_BACKFILL_SPAN_ATTRIBUTE.ChainId]: chain.publicChainId,
            ...explicitRangeRequestSpanAttributes(input),
        };
        // Load collection options so range summaries use the same context rules as pages.
        const collections = this.apm.withSyncSpan(
            "backend.sync_backfill.range.blockspace_collections",
            chainAttributes,
            () =>
                this.syncBackfillReadPort.listBlockspaceCollections(
                    chain.publicChainId,
                ),
        );
        const context = resolveCoverageContext(
            input.collectionRef,
            collections,
        );
        const contextAttributes = {
            ...chainAttributes,
            ...syncBackfillContextSpanAttributes(context),
        };
        // Read the local sync tip to bound explicit range validation.
        const highestSyncedBlock = this.apm.withSyncSpan(
            "backend.sync_backfill.range.highest_synced_block",
            contextAttributes,
            () =>
                this.syncBackfillReadPort.getHighestSyncedBlock(
                    chain.publicChainId,
                ),
        );
        const genesisBlock = resolveGenesisBlockNumber(chain);
        const head = await this.resolveHeadBlock(
            chain.publicChainId,
            highestSyncedBlock,
            genesisBlock,
        );
        const range = resolveExplicitCoverageRange(
            input,
            head.blockNumber,
            genesisBlock,
        );
        // Start timestamp resolution before local counts so RPC latency can overlap SQLite reads.
        const timePromise = this.resolvePageTime(
            chain.publicChainId,
            chain,
            range,
            genesisBlock,
        );
        const blockCount = countBlocks(range);
        const rangeAttributes = {
            ...contextAttributes,
            ...syncBackfillRangeSpanAttributes(range),
        };
        // Count selected blocks for the dynamic range summary widget.
        const syncedBlockCount = this.apm.withSyncSpan(
            "backend.sync_backfill.range.selected_range_count",
            rangeAttributes,
            () =>
                this.syncBackfillReadPort.countSyncedBlocksInRange(
                    chain.publicChainId,
                    context,
                    range,
                ),
        );
        const time = await timePromise;

        return {
            chain,
            context: {
                selected:
                    context.kind === "collection"
                        ? context.slug
                        : BLOCKSPACE_CONTEXT_ANY,
            },
            range: {
                ...range,
                blockCount,
                bucketSize: blockCount,
                syncedBlockCount,
                time,
            },
        };
    }

    private async resolveHeadBlock(
        chainId: number,
        highestSyncedBlock: number | null,
        genesisBlock: number,
    ): Promise<{ blockNumber: number; source: "rpc" | "indexed" }> {
        try {
            // Ask the configured chain head adapter for the live tip.
            const current = await this.apm.withSpan(
                "backend.sync_backfill.rpc.current_block_number",
                {
                    [SYNC_BACKFILL_SPAN_ATTRIBUTE.ChainId]: chainId,
                },
                () => this.chainHeadPort.getCurrentBlockNumber(),
            );
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
        const fromPromise = this.resolveBlockTimestamp(
            chainId,
            chain,
            page.fromBlock,
            genesisBlock,
        );
        let from: SyncBackfillBlockTimestamp;
        let to: SyncBackfillBlockTimestamp;
        if (page.toBlock === page.fromBlock) {
            from = await fromPromise;
            to = from;
        } else {
            [from, to] = await Promise.all([
                fromPromise,
                this.resolveBlockTimestamp(
                    chainId,
                    chain,
                    page.toBlock,
                    genesisBlock,
                ),
            ]);
        }
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
            return this.resolveRpcBlockTimestamp(chainId, blockNumber);
        }

        // Prefer indexed block metadata so time labels match local sync state.
        const localTimestamp = this.apm.withSyncSpan(
            "backend.sync_backfill.state.block_timestamp_db",
            {
                [SYNC_BACKFILL_SPAN_ATTRIBUTE.ChainId]: chainId,
                [SYNC_BACKFILL_SPAN_ATTRIBUTE.BlockNumber]: blockNumber,
            },
            () =>
                this.syncBackfillReadPort.getBlockTimestamp(
                    chainId,
                    blockNumber,
                ),
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

        return this.resolveRpcBlockTimestamp(chainId, blockNumber);
    }

    private async resolveRpcBlockTimestamp(
        chainId: number,
        blockNumber: number,
    ): Promise<SyncBackfillBlockTimestamp> {
        try {
            // Read JSON-RPC timestamps for explicit chain endpoints or DB misses.
            const rpcTimestamp = await this.apm.withSpan(
                "backend.sync_backfill.rpc.block_timestamp",
                {
                    [SYNC_BACKFILL_SPAN_ATTRIBUTE.ChainId]: chainId,
                    [SYNC_BACKFILL_SPAN_ATTRIBUTE.BlockNumber]: blockNumber,
                },
                () => this.chainHeadPort.getBlockTimestamp(blockNumber),
            );
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

function visibleContextCollections(
    collections: SyncBackfillCollectionOption[],
    context: SyncBackfillCoverageContext,
    options: "all" | "selected",
): SyncBackfillCollectionOption[] {
    if (options === "all") {
        return collections;
    }
    if (context.kind !== "collection") {
        return [];
    }
    return collections.filter(
        (collection) => collection.collectionId === context.collectionId,
    );
}

function resolveCoverageContext(
    collectionRef: string | null | undefined,
    collections: SyncBackfillCollectionOption[],
): SyncBackfillCoverageContext {
    const normalized =
        collectionRef && collectionRef.trim()
            ? normalizeSlugRef(collectionRef)
            : BLOCKSPACE_CONTEXT_ANY;
    if (normalized === BLOCKSPACE_CONTEXT_ANY) {
        return { kind: "any" };
    }

    const collection = collections.find(
        (candidate) => candidate.slug === normalized,
    );
    if (!collection) {
        throw new ReadModelNotFoundError("Unknown blockspace collection");
    }
    return {
        kind: "collection",
        collectionId: collection.collectionId,
        slug: collection.slug,
        deploymentBlock: collection.deploymentBlock,
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
        gridCellCount: BLOCKSPACE_GRID_CELL_COUNT,
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
        if (remaining % BLOCKSPACE_GRID_CELL_COUNT !== 0) return false;
        remaining /= BLOCKSPACE_GRID_CELL_COUNT;
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
    deploymentMarker: SyncBackfillGridCellDeploymentMarker | null,
    drillDownFloorBlock: number | null,
): SyncBackfillGridCell {
    const blockCount = countBlocks(count);
    return {
        index,
        fromBlock: count.fromBlock,
        toBlock: count.toBlock,
        blockCount,
        syncedBlockCount: count.syncedBlockCount,
        state: resolveCoverageState(blockCount, count.syncedBlockCount),
        canDrillDown:
            bucketSize > 1 &&
            blockCount > 0 &&
            !rangeEndsBeforeBlock(count, drillDownFloorBlock),
        collectionDeploymentBlock: rangeContainsBlock(
            count,
            deploymentMarker?.blockNumber ?? null,
        )
            ? deploymentMarker
            : null,
    };
}

function resolveDrillDownFloorBlock(
    context: SyncBackfillCoverageContext,
): number | null {
    return context.kind === "collection" ? context.deploymentBlock : null;
}

function resolveCollectionDeploymentMarker(
    chainId: number,
    context: SyncBackfillCoverageContext,
    page: SyncBackfillCoverageRange,
    syncBackfillReadPort: Pick<
        SyncBackfillReadPort,
        "countSyncedBlocksInRange"
    >,
): SyncBackfillGridCellDeploymentMarker | null {
    if (context.kind !== "collection" || context.deploymentBlock === null) {
        return null;
    }
    if (!rangeContainsBlock(page, context.deploymentBlock)) {
        return null;
    }
    const deploymentRange = {
        fromBlock: context.deploymentBlock,
        toBlock: context.deploymentBlock,
    };
    return {
        blockNumber: context.deploymentBlock,
        synced:
            syncBackfillReadPort.countSyncedBlocksInRange(
                chainId,
                context,
                deploymentRange,
            ) > 0,
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
    while (Math.ceil(blockCount / bucketSize) > BLOCKSPACE_GRID_CELL_COUNT) {
        bucketSize *= BLOCKSPACE_GRID_CELL_COUNT;
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
    return bucketSize * BLOCKSPACE_GRID_CELL_COUNT;
}

function countBlocks(range: SyncBackfillCoverageRange): number {
    if (range.fromBlock > range.toBlock) return 0;
    return range.toBlock - range.fromBlock + 1;
}

function sumSyncedBlockCounts(counts: SyncBackfillCoverageCount[]): number {
    return counts.reduce((total, count) => total + count.syncedBlockCount, 0);
}

function pageCoversWholeChain(
    page: SyncBackfillCoverageRange,
    genesisBlock: number,
    headBlock: number,
): boolean {
    return page.fromBlock === genesisBlock && page.toBlock === headBlock;
}

function rangeContainsBlock(
    range: SyncBackfillCoverageRange,
    blockNumber: number | null,
): boolean {
    return (
        blockNumber !== null &&
        range.fromBlock <= blockNumber &&
        blockNumber <= range.toBlock
    );
}

function rangeEndsBeforeBlock(
    range: SyncBackfillCoverageRange,
    blockNumber: number | null,
): boolean {
    return blockNumber !== null && range.toBlock < blockNumber;
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

function requestSpanAttributes(
    input: Pick<
        GetSyncBackfillStateInput,
        "collectionRef" | "pageStartBlock" | "bucketSize"
    >,
) {
    return {
        [SYNC_BACKFILL_SPAN_ATTRIBUTE.CollectionRefPresent]:
            Boolean(input.collectionRef?.trim()),
        [SYNC_BACKFILL_SPAN_ATTRIBUTE.PageStartPresent]:
            input.pageStartBlock !== null && input.pageStartBlock !== undefined,
        ...(input.pageStartBlock !== null &&
        input.pageStartBlock !== undefined
            ? {
                  [SYNC_BACKFILL_SPAN_ATTRIBUTE.PageStartBlock]:
                      input.pageStartBlock,
              }
            : {}),
        ...(input.bucketSize !== null && input.bucketSize !== undefined
            ? {
                  [SYNC_BACKFILL_SPAN_ATTRIBUTE.BucketSize]:
                      input.bucketSize,
              }
            : {}),
    };
}

function explicitRangeRequestSpanAttributes(
    input: Pick<
        GetSyncBackfillRangeSummaryInput,
        "collectionRef" | "fromBlock" | "toBlock"
    >,
) {
    return {
        [SYNC_BACKFILL_SPAN_ATTRIBUTE.CollectionRefPresent]:
            Boolean(input.collectionRef?.trim()),
        [SYNC_BACKFILL_SPAN_ATTRIBUTE.FromBlock]: input.fromBlock,
        [SYNC_BACKFILL_SPAN_ATTRIBUTE.ToBlock]: input.toBlock,
        [SYNC_BACKFILL_SPAN_ATTRIBUTE.BlockCount]:
            input.fromBlock > input.toBlock
                ? 0
                : input.toBlock - input.fromBlock + 1,
    };
}
