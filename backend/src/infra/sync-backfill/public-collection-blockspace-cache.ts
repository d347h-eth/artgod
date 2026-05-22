import { BLOCKSPACE_GRID_CELL_COUNT } from "@artgod/shared/config/blockspace";
import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import {
    QUERY_CACHE_DEBUG_STATUSES,
    setCurrentQueryCacheDebugInfo,
} from "../../utils/query-cache-debug.js";
import type {
    SyncBackfillCollectionOption,
    SyncBackfillCoverageContext,
    SyncBackfillCoverageCount,
    SyncBackfillCoverageRange,
    SyncBackfillReadPort,
} from "../../application/use-cases/sync-backfill/get-sync-backfill-state.js";

type IntervalRow = {
    from_block: number;
    to_block: number;
    block_count: number;
};

type BucketCountRow = {
    bucket_index: number;
    block_count: number;
};

type PublicCollectionBlockspaceSnapshot = {
    chainId: number;
    collectionId: number;
    collectionSlug: string;
    fromBlock: number;
    toBlock: number;
    totalSyncedBlockCount: number;
    starts: Uint32Array;
    ends: Uint32Array;
    prefixBefore: Uint32Array;
    bucketBaseBlock: number;
    bucketCounts: Uint16Array;
    storedAt: number;
};

export type PublicCollectionBlockspaceCacheOptions = {
    chainId: number;
    collectionRef: string;
    refreshMs: number;
};

const UNKNOWN_DEPLOYMENT_BLOCK = 0;
const CACHE_COMPONENT = "PublicCollectionBlockspaceCache";
const CACHE_BUCKET_SIZE = BLOCKSPACE_GRID_CELL_COUNT;

export class PublicCollectionBlockspaceCache implements SyncBackfillReadPort {
    private readonly chainId: number;
    private readonly collectionRef: string;
    private readonly refreshMs: number;
    private refreshTimer: ReturnType<typeof setInterval> | null = null;
    private snapshot: PublicCollectionBlockspaceSnapshot | null = null;

    private readonly selectIntervals = db.prepare<{
        chainId: number;
        collectionId: number;
        fromBlock: number;
        toBlock: number;
    }>(
        "WITH ordered AS (" +
            "SELECT block_number, " +
            "block_number - ROW_NUMBER() OVER (ORDER BY block_number) AS island_key " +
            "FROM collection_sync_blocks " +
            "WHERE chain_id = @chainId " +
            "AND collection_id = @collectionId " +
            "AND block_number BETWEEN @fromBlock AND @toBlock" +
            ") " +
            "SELECT MIN(block_number) AS from_block, " +
            "MAX(block_number) AS to_block, " +
            "COUNT(1) AS block_count " +
            "FROM ordered " +
            "GROUP BY island_key " +
            "ORDER BY from_block",
    );

    private readonly selectBucketCounts = db.prepare<{
        chainId: number;
        collectionId: number;
        fromBlock: number;
        toBlock: number;
        bucketBaseBlock: number;
        bucketSize: number;
    }>(
        "SELECT CAST((block_number - @bucketBaseBlock) / @bucketSize AS INTEGER) AS bucket_index, " +
            "COUNT(1) AS block_count " +
            "FROM collection_sync_blocks " +
            "WHERE chain_id = @chainId " +
            "AND collection_id = @collectionId " +
            "AND block_number BETWEEN @fromBlock AND @toBlock " +
            "GROUP BY bucket_index " +
            "ORDER BY bucket_index",
    );

    constructor(
        private readonly inner: SyncBackfillReadPort,
        options: PublicCollectionBlockspaceCacheOptions,
    ) {
        this.chainId = options.chainId;
        this.collectionRef = options.collectionRef;
        this.refreshMs = Math.max(1, options.refreshMs);
    }

    start(): void {
        if (this.refreshTimer) {
            return;
        }

        this.refreshNow();
        this.refreshTimer = setInterval(() => {
            this.refreshSafely();
        }, this.refreshMs);
        this.refreshTimer.unref?.();
    }

    stop(): void {
        if (!this.refreshTimer) {
            return;
        }
        clearInterval(this.refreshTimer);
        this.refreshTimer = null;
    }

    refreshNow(): void {
        const snapshot = this.buildSnapshot();
        this.snapshot = snapshot;
        logger.info("Public blockspace cache refreshed", {
            component: CACHE_COMPONENT,
            action: "refresh",
            chainId: snapshot.chainId,
            collectionId: snapshot.collectionId,
            collectionSlug: snapshot.collectionSlug,
            fromBlock: snapshot.fromBlock,
            toBlock: snapshot.toBlock,
            intervals: snapshot.starts.length,
            bucketCount: snapshot.bucketCounts.length,
            syncedBlockCount: snapshot.totalSyncedBlockCount,
        });
    }

    listBlockspaceCollections(chainId: number): SyncBackfillCollectionOption[] {
        return this.inner.listBlockspaceCollections(chainId);
    }

    getHighestSyncedBlock(chainId: number): number | null {
        return this.inner.getHighestSyncedBlock(chainId);
    }

    getBlockTimestamp(chainId: number, blockNumber: number): number | null {
        return this.inner.getBlockTimestamp(chainId, blockNumber);
    }

    countSyncedBlocks(
        chainId: number,
        context: SyncBackfillCoverageContext,
    ): number {
        const snapshot = this.resolveSnapshot(chainId, context);
        if (!snapshot) {
            return this.inner.countSyncedBlocks(chainId, context);
        }
        this.markHit(snapshot);
        return snapshot.totalSyncedBlockCount;
    }

    countSyncedBlocksInRange(
        chainId: number,
        context: SyncBackfillCoverageContext,
        range: SyncBackfillCoverageRange,
    ): number {
        const snapshot = this.resolveSnapshot(chainId, context);
        if (!snapshot) {
            return this.inner.countSyncedBlocksInRange(chainId, context, range);
        }
        this.markHit(snapshot);
        return countSnapshotRange(snapshot, range);
    }

    countSyncedBlocksByRange(
        chainId: number,
        context: SyncBackfillCoverageContext,
        ranges: SyncBackfillCoverageRange[],
    ): SyncBackfillCoverageCount[] {
        const snapshot = this.resolveSnapshot(chainId, context);
        if (!snapshot) {
            return this.inner.countSyncedBlocksByRange(
                chainId,
                context,
                ranges,
            );
        }
        this.markHit(snapshot);
        return ranges.map((range) => ({
            ...range,
            syncedBlockCount: countSnapshotRange(snapshot, range),
        }));
    }

    private refreshSafely(): void {
        try {
            this.refreshNow();
        } catch (error) {
            logger.error("Public blockspace cache refresh failed", {
                component: CACHE_COMPONENT,
                action: "refresh",
                chainId: this.chainId,
                collectionRef: this.collectionRef,
                error: String(error),
            });
        }
    }

    private buildSnapshot(): PublicCollectionBlockspaceSnapshot {
        const collection = this.resolveCollection();
        const highestSyncedBlock = this.inner.getHighestSyncedBlock(
            this.chainId,
        );
        const fromBlock =
            collection.deploymentBlock ?? UNKNOWN_DEPLOYMENT_BLOCK;
        const toBlock = Math.max(fromBlock, highestSyncedBlock ?? fromBlock);
        const intervals = this.selectIntervals.all({
            chainId: this.chainId,
            collectionId: collection.collectionId,
            fromBlock,
            toBlock,
        }) as IntervalRow[];
        const bucketBaseBlock =
            Math.floor(fromBlock / CACHE_BUCKET_SIZE) * CACHE_BUCKET_SIZE;
        const bucketCount =
            Math.floor((toBlock - bucketBaseBlock) / CACHE_BUCKET_SIZE) + 1;
        const bucketCounts = new Uint16Array(Math.max(0, bucketCount));
        const bucketRows = this.selectBucketCounts.all({
            chainId: this.chainId,
            collectionId: collection.collectionId,
            fromBlock,
            toBlock,
            bucketBaseBlock,
            bucketSize: CACHE_BUCKET_SIZE,
        }) as BucketCountRow[];
        for (const row of bucketRows) {
            if (row.bucket_index >= 0 && row.bucket_index < bucketCounts.length) {
                bucketCounts[row.bucket_index] = row.block_count;
            }
        }

        return {
            chainId: this.chainId,
            collectionId: collection.collectionId,
            collectionSlug: collection.slug,
            fromBlock,
            toBlock,
            ...buildIntervalArrays(intervals),
            bucketBaseBlock,
            bucketCounts,
            storedAt: Date.now(),
        };
    }

    private resolveCollection(): SyncBackfillCollectionOption {
        const collection = this.inner
            .listBlockspaceCollections(this.chainId)
            .find((candidate) => candidate.slug === this.collectionRef);
        if (!collection) {
            throw new Error("Public blockspace cache collection not found");
        }
        return collection;
    }

    private resolveSnapshot(
        chainId: number,
        context: SyncBackfillCoverageContext,
    ): PublicCollectionBlockspaceSnapshot | null {
        const snapshot = this.snapshot;
        if (!snapshot) {
            setCurrentQueryCacheDebugInfo({
                status: QUERY_CACHE_DEBUG_STATUSES.Miss,
                ageMs: 0,
                ttlMs: this.refreshMs,
            });
            return null;
        }
        if (
            chainId !== snapshot.chainId ||
            context.kind !== "collection" ||
            context.collectionId !== snapshot.collectionId
        ) {
            setCurrentQueryCacheDebugInfo({
                status: QUERY_CACHE_DEBUG_STATUSES.Bypass,
            });
            return null;
        }
        return snapshot;
    }

    private markHit(snapshot: PublicCollectionBlockspaceSnapshot): void {
        setCurrentQueryCacheDebugInfo({
            status: QUERY_CACHE_DEBUG_STATUSES.Hit,
            ageMs: Math.max(0, Date.now() - snapshot.storedAt),
            ttlMs: this.refreshMs,
        });
    }
}

function buildIntervalArrays(intervals: IntervalRow[]): {
    totalSyncedBlockCount: number;
    starts: Uint32Array;
    ends: Uint32Array;
    prefixBefore: Uint32Array;
} {
    const starts = new Uint32Array(intervals.length);
    const ends = new Uint32Array(intervals.length);
    const prefixBefore = new Uint32Array(intervals.length);
    let totalSyncedBlockCount = 0;
    intervals.forEach((interval, index) => {
        starts[index] = interval.from_block;
        ends[index] = interval.to_block;
        prefixBefore[index] = totalSyncedBlockCount;
        totalSyncedBlockCount += interval.block_count;
    });
    return {
        totalSyncedBlockCount,
        starts,
        ends,
        prefixBefore,
    };
}

function countSnapshotRange(
    snapshot: PublicCollectionBlockspaceSnapshot,
    range: SyncBackfillCoverageRange,
): number {
    if (range.fromBlock > range.toBlock || snapshot.starts.length === 0) {
        return 0;
    }
    const bucketCount = countSnapshotBucketRange(snapshot, range);
    if (bucketCount !== null) {
        return bucketCount;
    }
    const fromBlock = Math.max(range.fromBlock, snapshot.fromBlock);
    const toBlock = Math.min(range.toBlock, snapshot.toBlock);
    if (fromBlock > toBlock) {
        return 0;
    }

    const first = lowerBound(snapshot.ends, fromBlock);
    const last = upperBound(snapshot.starts, toBlock) - 1;
    if (first > last || first >= snapshot.starts.length || last < 0) {
        return 0;
    }
    if (first === last) {
        return countOverlap(
            snapshot.starts[first],
            snapshot.ends[first],
            fromBlock,
            toBlock,
        );
    }

    const firstOverlap = countOverlap(
        snapshot.starts[first],
        snapshot.ends[first],
        fromBlock,
        toBlock,
    );
    const lastOverlap = countOverlap(
        snapshot.starts[last],
        snapshot.ends[last],
        fromBlock,
        toBlock,
    );
    const fullMiddle =
        first + 1 <= last - 1
            ? snapshot.prefixBefore[last] - snapshot.prefixBefore[first + 1]
            : 0;
    return firstOverlap + fullMiddle + lastOverlap;
}

function countSnapshotBucketRange(
    snapshot: PublicCollectionBlockspaceSnapshot,
    range: SyncBackfillCoverageRange,
): number | null {
    const fromBlock = Math.max(range.fromBlock, snapshot.bucketBaseBlock);
    const toBlock = Math.min(range.toBlock, snapshot.toBlock);
    if (fromBlock > toBlock) {
        return 0;
    }
    const firstOffset = fromBlock - snapshot.bucketBaseBlock;
    const endExclusiveOffset = toBlock + 1 - snapshot.bucketBaseBlock;
    if (
        firstOffset % CACHE_BUCKET_SIZE !== 0 ||
        endExclusiveOffset % CACHE_BUCKET_SIZE !== 0
    ) {
        return null;
    }

    const firstIndex = firstOffset / CACHE_BUCKET_SIZE;
    const lastExclusiveIndex = endExclusiveOffset / CACHE_BUCKET_SIZE;
    if (
        firstIndex < 0 ||
        lastExclusiveIndex > snapshot.bucketCounts.length ||
        firstIndex >= lastExclusiveIndex
    ) {
        return null;
    }

    let total = 0;
    for (let index = firstIndex; index < lastExclusiveIndex; index += 1) {
        total += snapshot.bucketCounts[index];
    }
    return total;
}

function countOverlap(
    intervalStart: number,
    intervalEnd: number,
    rangeStart: number,
    rangeEnd: number,
): number {
    const fromBlock = Math.max(intervalStart, rangeStart);
    const toBlock = Math.min(intervalEnd, rangeEnd);
    return fromBlock <= toBlock ? toBlock - fromBlock + 1 : 0;
}

function lowerBound(values: Uint32Array, target: number): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (values[mid] < target) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
}

function upperBound(values: Uint32Array, target: number): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (values[mid] <= target) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
}
