import { randomUUID } from "node:crypto";
import { logger } from "@artgod/shared/utils";
import type { CollectionRecord } from "../domain/collections.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
    SYNC_JOB_KIND,
    type BackfillSyncPayload,
} from "../domain/sync-jobs.js";
import type { QueuePort } from "../ports/queue.js";

// Bound SQLite work and durable outstanding ranges independently of RPC log
// chunking. Retries reuse the saved job identity, including across restarts.
export const SYNC_GAP_POLICY = {
    ScanWindowBlocks: 10_000,
    CollectionsPerPass: 16,
    RetryDelayMs: 5 * 60_000,
} as const;

const SYNC_GAP_LOG_COMPONENT = "IndexerSyncGapScheduler";

export type SyncGapRange = { fromBlock: number; toBlock: number };
export type PendingSyncGapRepair = SyncGapRange & {
    jobId: string;
    retryAt: number;
};
export type SyncGapProgress = {
    anchorBlock: number;
    // null starts a new sweep from the currently observed head.
    cursorBlock: number | null;
    pending: PendingSyncGapRepair | null;
};

export interface SyncGapCollectionsPort {
    listCollectionsForGapRepair(
        chainId: number,
        afterCollectionId: number,
        limit: number,
    ): CollectionRecord[];
}

export interface SyncGapStorePort {
    getProgress(chainId: number, collectionId: number): SyncGapProgress | null;
    saveProgress(
        chainId: number,
        collectionId: number,
        progress: SyncGapProgress,
    ): void;
    // Returns the highest missing contiguous range, capped to batchSize, from
    // collection coverage only. Implementations must bound reads to window.
    findGap(
        chainId: number,
        collectionId: number,
        window: SyncGapRange,
        batchSize: number,
    ): SyncGapRange | null;
    deferRetry(
        chainId: number,
        collectionId: number,
        jobId: string,
        retryAt: number,
    ): void;
    // Only the matching worker may complete a repair, after downstream fanout.
    completeRepair(chainId: number, collectionId: number, jobId: string): void;
}

export interface SyncGapDetectorPort {
    scan(headBlock: number): Promise<void>;
}

export type SyncGapSchedulerOptions = {
    chainId: number;
    batchSize: number;
    scanWindowBlocks?: number;
    collectionsPerPass?: number;
    retryDelayMs?: number;
    now?: () => number;
};

// Each pass visits a bounded page of collections. Each collection retains one
// outstanding repair, so slow workers cannot admit the whole missing history.
export class SyncGapScheduler implements SyncGapDetectorPort {
    private afterCollectionId = 0;
    private active: Promise<void> | null = null;
    private readonly windowSize: number;
    private readonly pageSize: number;
    private readonly retryDelayMs: number;
    private readonly now: () => number;

    constructor(
        private readonly collections: SyncGapCollectionsPort,
        private readonly store: SyncGapStorePort,
        private readonly queue: Pick<QueuePort, "publish">,
        private readonly options: SyncGapSchedulerOptions,
    ) {
        this.windowSize =
            options.scanWindowBlocks ?? SYNC_GAP_POLICY.ScanWindowBlocks;
        this.pageSize =
            options.collectionsPerPass ?? SYNC_GAP_POLICY.CollectionsPerPass;
        this.retryDelayMs =
            options.retryDelayMs ?? SYNC_GAP_POLICY.RetryDelayMs;
        this.now = options.now ?? Date.now;
        for (const value of [
            options.batchSize,
            this.windowSize,
            this.pageSize,
            this.retryDelayMs,
        ]) {
            if (!Number.isSafeInteger(value) || value < 1)
                throw new Error(
                    "Sync gap limits must be positive safe integers",
                );
        }
    }

    scan(headBlock: number): Promise<void> {
        if (this.active) return this.active;
        this.active = this.scanPage(headBlock).finally(() => {
            this.active = null;
        });
        return this.active;
    }

    private async scanPage(headBlock: number): Promise<void> {
        if (!Number.isSafeInteger(headBlock) || headBlock < 1) return;
        let collections = this.collections.listCollectionsForGapRepair(
            this.options.chainId,
            this.afterCollectionId,
            this.pageSize,
        );
        if (collections.length === 0 && this.afterCollectionId !== 0) {
            this.afterCollectionId = 0;
            collections = this.collections.listCollectionsForGapRepair(
                this.options.chainId,
                0,
                this.pageSize,
            );
        }
        for (const collection of collections) {
            this.afterCollectionId = collection.id;
            try {
                await this.scanCollection(collection, headBlock);
            } catch (error) {
                // A failed collection or publish must not starve other collections.
                logger.warn("Collection gap scan failed", {
                    component: SYNC_GAP_LOG_COMPONENT,
                    action: "scan",
                    chainId: this.options.chainId,
                    collectionId: collection.id,
                    error: String(error),
                });
            }
        }
    }

    private async scanCollection(
        collection: CollectionRecord,
        headBlock: number,
    ): Promise<void> {
        const window = collection.gapRepairWindow(headBlock);
        if (!window) return;
        const chainId = this.options.chainId;
        let progress = this.store.getProgress(chainId, collection.id);
        if (!progress || progress.anchorBlock !== window.fromBlock) {
            progress = {
                anchorBlock: window.fromBlock,
                cursorBlock: null,
                pending: null,
            };
        }
        if (!progress.pending) {
            const end = Math.min(progress.cursorBlock ?? headBlock, headBlock);
            const scanWindow = {
                fromBlock: Math.max(
                    window.fromBlock,
                    end - this.windowSize + 1,
                ),
                toBlock: end,
            };
            const gap = this.store.findGap(
                chainId,
                collection.id,
                scanWindow,
                this.options.batchSize,
            );
            const nextCursor = (gap?.fromBlock ?? scanWindow.fromBlock) - 1;
            progress = {
                anchorBlock: window.fromBlock,
                cursorBlock: nextCursor < window.fromBlock ? null : nextCursor,
                pending: gap
                    ? {
                          ...gap,
                          jobId: `sync:gap:${chainId}:${collection.id}:${randomUUID()}`,
                          retryAt: this.now(),
                      }
                    : null,
            };
            // Commit intent before publishing. A crash or rejected publication is
            // retried from this same row, never mistaken for completed coverage.
            this.store.saveProgress(chainId, collection.id, progress);
        }
        const pending = progress.pending;
        if (
            !pending ||
            pending.retryAt > this.now() ||
            pending.toBlock > headBlock
        )
            return;
        const job: JobEnvelope<BackfillSyncPayload> = {
            jobId: pending.jobId,
            kind: SYNC_JOB_KIND.BackfillRange,
            queue: QUEUE_NAMES.BackfillSync,
            chainId,
            collectionId: collection.id,
            attempt: 0,
            scheduledAt: this.now(),
            payload: {
                fromBlock: pending.fromBlock,
                toBlock: pending.toBlock,
                source: BACKFILL_SOURCE.GapRepair,
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
            },
        };
        await this.queue.publish(QUEUE_NAMES.BackfillSync, job);
        this.store.deferRetry(
            chainId,
            collection.id,
            job.jobId,
            this.now() + this.retryDelayMs,
        );
        logger.info("Collection gap repair scheduled", {
            component: SYNC_GAP_LOG_COMPONENT,
            action: "schedule",
            chainId,
            collectionId: collection.id,
            jobId: job.jobId,
            fromBlock: pending.fromBlock,
            toBlock: pending.toBlock,
        });
    }
}

// Late duplicate jobs, purged collections, and jobs from a replaced anchor do
// not re-enter the pipeline. Raw coverage alone does not complete this intent:
// the worker must also finish publishing the downstream jobs.
export function isCurrentSyncGapRepair(
    job: JobEnvelope<BackfillSyncPayload>,
    collection: CollectionRecord | null,
    store: Pick<SyncGapStorePort, "getProgress">,
): collection is CollectionRecord {
    if (
        !collection ||
        job.chainId !== collection.chainId ||
        job.collectionId !== collection.id
    )
        return false;
    const window = collection.gapRepairWindow(job.payload.toBlock);
    if (
        !window ||
        job.payload.fromBlock < window.fromBlock ||
        job.payload.fromBlock > job.payload.toBlock
    )
        return false;
    const progress = store.getProgress(collection.chainId, collection.id);
    return (
        progress?.anchorBlock === window.fromBlock &&
        progress.pending?.jobId === job.jobId &&
        progress.pending.fromBlock === job.payload.fromBlock &&
        progress.pending.toBlock === job.payload.toBlock
    );
}

// The runtime invokes this inside its current-state execution gate. Reloading
// here prevents jobs waiting behind another backfill from using stale liveness
// or anchor state. Completion follows the entire sync and fanout operation.
export async function executeSyncGapRepair(
    job: JobEnvelope<BackfillSyncPayload>,
    collections: {
        getCollection(
            chainId: number,
            collectionId: number,
        ): CollectionRecord | null;
    },
    store: Pick<SyncGapStorePort, "getProgress" | "completeRepair">,
    syncAndPublish: (collection: CollectionRecord) => Promise<void>,
): Promise<boolean> {
    if (job.collectionId === undefined) return false;
    const collection = collections.getCollection(job.chainId, job.collectionId);
    if (!isCurrentSyncGapRepair(job, collection, store)) return false;
    await syncAndPublish(collection);
    store.completeRepair(job.chainId, collection.id, job.jobId);
    return true;
}
