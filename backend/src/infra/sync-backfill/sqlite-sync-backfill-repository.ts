import { db } from "@artgod/shared/database";
import {
    NOOP_APM,
    type ApmPort,
} from "@artgod/shared/observability/apm";
import type {
    SyncBackfillCollectionOption,
    SyncBackfillCoverageContext,
    SyncBackfillCoverageCount,
    SyncBackfillCoverageRange,
    SyncBackfillReadPort,
} from "../../application/use-cases/sync-backfill/get-sync-backfill-state.js";
import {
    SYNC_BACKFILL_SPAN_ATTRIBUTE,
    syncBackfillContextSpanAttributes,
    syncBackfillRangeSpanAttributes,
} from "../../application/use-cases/sync-backfill/sync-backfill-observability.js";

type CollectionRow = {
    chain_id: number;
    collection_id: number;
    slug: string;
    address: string;
    status: "live";
    deployment_block: number | null;
    bootstrap_anchor_block: number | null;
    bootstrap_last_synced_block: number | null;
};

type CountRow = {
    count: number;
};

type MaxBlockRow = {
    max_block_number: number | null;
};

type BlockTimestampRow = {
    timestamp: number;
};

type BucketCountRow = {
    bucket_index: number;
    count: number;
};

type BucketQueryInput = {
    fromBlock: number;
    toBlock: number;
    bucketSize: number;
};

const COLLECTION_COLUMNS =
    "chain_id, collection_id, slug, address, status, deployment_block, bootstrap_anchor_block, bootstrap_last_synced_block";

export class SqliteSyncBackfillRepository implements SyncBackfillReadPort {
    private selectLiveCollections = db.prepare<{ chainId: number }>(
        `SELECT ${COLLECTION_COLUMNS} ` +
            "FROM collections " +
            "WHERE chain_id = @chainId AND status = 'live' " +
            "AND bootstrap_anchor_block IS NOT NULL " +
            "ORDER BY slug ASC",
    );
    private selectMaxSyncedBlock = db.prepare<{ chainId: number }>(
        "SELECT MAX(block_number) AS max_block_number FROM blocks WHERE chain_id = @chainId",
    );
    private selectBlockTimestamp = db.prepare<{
        chainId: number;
        blockNumber: number;
    }>(
        "SELECT timestamp FROM blocks " +
            "WHERE chain_id = @chainId AND block_number = @blockNumber",
    );
    private countAnySyncedBlocksStmt = db.prepare<{ chainId: number }>(
        "SELECT COUNT(1) AS count FROM blocks WHERE chain_id = @chainId",
    );
    private countCollectionSyncedBlocksStmt = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "SELECT COUNT(1) AS count FROM collection_sync_blocks " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId",
    );
    private countAnySyncedBlocksInRangeStmt = db.prepare<{
        chainId: number;
        fromBlock: number;
        toBlock: number;
    }>(
        "SELECT COUNT(1) AS count FROM blocks " +
            "WHERE chain_id = @chainId AND block_number BETWEEN @fromBlock AND @toBlock",
    );
    private countCollectionSyncedBlocksInRangeStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        fromBlock: number;
        toBlock: number;
    }>(
        "SELECT COUNT(1) AS count FROM collection_sync_blocks " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "AND block_number BETWEEN @fromBlock AND @toBlock",
    );
    private countAnySyncedBlocksByBucketStmt = db.prepare<{
        chainId: number;
        fromBlock: number;
        toBlock: number;
        bucketSize: number;
    }>(
        "SELECT CAST((block_number - @fromBlock) / @bucketSize AS INTEGER) AS bucket_index, " +
            "COUNT(1) AS count FROM blocks " +
            "WHERE chain_id = @chainId AND block_number BETWEEN @fromBlock AND @toBlock " +
            "GROUP BY bucket_index",
    );
    private countCollectionSyncedBlocksByBucketStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        fromBlock: number;
        toBlock: number;
        bucketSize: number;
    }>(
        "SELECT CAST((block_number - @fromBlock) / @bucketSize AS INTEGER) AS bucket_index, " +
            "COUNT(1) AS count FROM collection_sync_blocks " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "AND block_number BETWEEN @fromBlock AND @toBlock " +
            "GROUP BY bucket_index",
    );

    constructor(private readonly apm: ApmPort = NOOP_APM) {}

    listLiveCollections(chainId: number): SyncBackfillCollectionOption[] {
        return this.apm.withSyncSpan(
            "backend.sync_backfill.sqlite.live_collections",
            {
                [SYNC_BACKFILL_SPAN_ATTRIBUTE.ChainId]: chainId,
            },
            () => this.listLiveCollectionsInner(chainId),
        );
    }

    private listLiveCollectionsInner(
        chainId: number,
    ): SyncBackfillCollectionOption[] {
        const rows = this.selectLiveCollections.all({
            chainId,
        }) as CollectionRow[];
        return rows.map((row) => ({
            chainId: row.chain_id,
            collectionId: row.collection_id,
            slug: row.slug,
            address: row.address,
            status: row.status,
            deploymentBlock: row.deployment_block,
            bootstrapAnchorBlock: row.bootstrap_anchor_block,
            bootstrapLastSyncedBlock: row.bootstrap_last_synced_block,
        }));
    }

    getHighestSyncedBlock(chainId: number): number | null {
        return this.apm.withSyncSpan(
            "backend.sync_backfill.sqlite.highest_synced_block",
            {
                [SYNC_BACKFILL_SPAN_ATTRIBUTE.ChainId]: chainId,
            },
            () => this.getHighestSyncedBlockInner(chainId),
        );
    }

    private getHighestSyncedBlockInner(chainId: number): number | null {
        const row = this.selectMaxSyncedBlock.get({
            chainId,
        }) as MaxBlockRow | undefined;
        return row?.max_block_number ?? null;
    }

    getBlockTimestamp(chainId: number, blockNumber: number): number | null {
        return this.apm.withSyncSpan(
            "backend.sync_backfill.sqlite.block_timestamp",
            {
                [SYNC_BACKFILL_SPAN_ATTRIBUTE.ChainId]: chainId,
                [SYNC_BACKFILL_SPAN_ATTRIBUTE.BlockNumber]: blockNumber,
            },
            () => this.getBlockTimestampInner(chainId, blockNumber),
        );
    }

    private getBlockTimestampInner(
        chainId: number,
        blockNumber: number,
    ): number | null {
        const row = this.selectBlockTimestamp.get({
            chainId,
            blockNumber,
        }) as BlockTimestampRow | undefined;
        return row?.timestamp ?? null;
    }

    countSyncedBlocks(
        chainId: number,
        context: SyncBackfillCoverageContext,
    ): number {
        return this.apm.withSyncSpan(
            "backend.sync_backfill.sqlite.total_count",
            {
                [SYNC_BACKFILL_SPAN_ATTRIBUTE.ChainId]: chainId,
                ...syncBackfillContextSpanAttributes(context),
            },
            () => this.countSyncedBlocksInner(chainId, context),
        );
    }

    private countSyncedBlocksInner(
        chainId: number,
        context: SyncBackfillCoverageContext,
    ): number {
        if (context.kind === "collection") {
            return readCount(
                this.countCollectionSyncedBlocksStmt.get({
                    chainId,
                    collectionId: context.collectionId,
                }),
            );
        }
        return readCount(this.countAnySyncedBlocksStmt.get({ chainId }));
    }

    countSyncedBlocksInRange(
        chainId: number,
        context: SyncBackfillCoverageContext,
        range: SyncBackfillCoverageRange,
    ): number {
        return this.apm.withSyncSpan(
            "backend.sync_backfill.sqlite.range_count",
            {
                [SYNC_BACKFILL_SPAN_ATTRIBUTE.ChainId]: chainId,
                ...syncBackfillContextSpanAttributes(context),
                ...syncBackfillRangeSpanAttributes(range),
            },
            () => this.countSyncedBlocksInRangeInner(chainId, context, range),
        );
    }

    private countSyncedBlocksInRangeInner(
        chainId: number,
        context: SyncBackfillCoverageContext,
        range: SyncBackfillCoverageRange,
    ): number {
        if (range.fromBlock > range.toBlock) return 0;
        if (context.kind === "collection") {
            return readCount(
                this.countCollectionSyncedBlocksInRangeStmt.get({
                    chainId,
                    collectionId: context.collectionId,
                    fromBlock: range.fromBlock,
                    toBlock: range.toBlock,
                }),
            );
        }
        return readCount(
            this.countAnySyncedBlocksInRangeStmt.get({
                chainId,
                fromBlock: range.fromBlock,
                toBlock: range.toBlock,
            }),
        );
    }

    countSyncedBlocksByRange(
        chainId: number,
        context: SyncBackfillCoverageContext,
        ranges: SyncBackfillCoverageRange[],
    ): SyncBackfillCoverageCount[] {
        const bucketQuery = resolveBucketQueryInput(ranges);
        return this.apm.withSyncSpan(
            "backend.sync_backfill.sqlite.count_by_range",
            {
                [SYNC_BACKFILL_SPAN_ATTRIBUTE.ChainId]: chainId,
                ...syncBackfillContextSpanAttributes(context),
                [SYNC_BACKFILL_SPAN_ATTRIBUTE.RangesCount]: ranges.length,
                [SYNC_BACKFILL_SPAN_ATTRIBUTE.BucketQueryPresent]:
                    bucketQuery !== null,
                ...(bucketQuery
                    ? {
                          [SYNC_BACKFILL_SPAN_ATTRIBUTE.FromBlock]:
                              bucketQuery.fromBlock,
                          [SYNC_BACKFILL_SPAN_ATTRIBUTE.ToBlock]:
                              bucketQuery.toBlock,
                          [SYNC_BACKFILL_SPAN_ATTRIBUTE.BucketSize]:
                              bucketQuery.bucketSize,
                      }
                    : {}),
            },
            () =>
                this.countSyncedBlocksByRangeInner(
                    chainId,
                    context,
                    ranges,
                    bucketQuery,
                ),
        );
    }

    private countSyncedBlocksByRangeInner(
        chainId: number,
        context: SyncBackfillCoverageContext,
        ranges: SyncBackfillCoverageRange[],
        bucketQuery: BucketQueryInput | null,
    ): SyncBackfillCoverageCount[] {
        if (bucketQuery) {
            return this.countSyncedBlocksByBucket(
                chainId,
                context,
                ranges,
                bucketQuery,
            );
        }

        return ranges.map((range) => ({
            ...range,
            syncedBlockCount: this.countSyncedBlocksInRangeInner(
                chainId,
                context,
                range,
            ),
        }));
    }

    private countSyncedBlocksByBucket(
        chainId: number,
        context: SyncBackfillCoverageContext,
        ranges: SyncBackfillCoverageRange[],
        bucketQuery: BucketQueryInput,
    ): SyncBackfillCoverageCount[] {
        const rows =
            context.kind === "collection"
                ? this.countCollectionSyncedBlocksByBucketStmt.all({
                      chainId,
                      collectionId: context.collectionId,
                      ...bucketQuery,
                  })
                : this.countAnySyncedBlocksByBucketStmt.all({
                      chainId,
                      ...bucketQuery,
                  });
        const countByBucket = new Map(
            (rows as BucketCountRow[]).map((row) => [
                row.bucket_index,
                row.count,
            ]),
        );
        return ranges.map((range, index) => ({
            ...range,
            syncedBlockCount: countByBucket.get(index) ?? 0,
        }));
    }
}

function readCount(row: unknown): number {
    return (row as CountRow | undefined)?.count ?? 0;
}

function resolveBucketQueryInput(
    ranges: SyncBackfillCoverageRange[],
): BucketQueryInput | null {
    if (ranges.length < 2) return null;

    const fromBlock = ranges[0]?.fromBlock;
    const bucketSize = ranges[1].fromBlock - ranges[0].fromBlock;
    if (
        fromBlock === undefined ||
        !Number.isInteger(bucketSize) ||
        bucketSize <= 0
    ) {
        return null;
    }

    let toBlock: number | null = null;
    let reachedTerminalRange = false;
    for (let index = 0; index < ranges.length; index += 1) {
        const range = ranges[index];
        const expectedFromBlock = fromBlock + index * bucketSize;
        if (range.fromBlock !== expectedFromBlock) return null;
        const expectedToBlock = expectedFromBlock + bucketSize - 1;
        const isEmptyRange = range.toBlock < range.fromBlock;
        if (isEmptyRange) {
            if (range.toBlock !== range.fromBlock - 1) return null;
            reachedTerminalRange = true;
            continue;
        }
        if (reachedTerminalRange || range.toBlock > expectedToBlock) {
            return null;
        }
        toBlock = range.toBlock;
        if (range.toBlock < expectedToBlock) {
            reachedTerminalRange = true;
        }
    }

    if (toBlock === null) return null;
    return { fromBlock, toBlock, bucketSize };
}
