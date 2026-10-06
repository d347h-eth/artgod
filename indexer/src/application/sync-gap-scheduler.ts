import { createHash, randomUUID } from "node:crypto";
import { logger } from "@artgod/shared/utils";
import type { CollectionRecord } from "../domain/collections.js";
import type { DomainSyncSource } from "../domain/domain-jobs.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
    SYNC_JOB_KIND,
    decodeBackfillSyncJob,
    type BackfillSyncPayload,
    type SyncGapRepairTarget,
} from "../domain/sync-jobs.js";
import {
    planSyncGapRepairBatches,
    remainingSyncGapRepairRange,
} from "../domain/sync-gap-repair.js";
import type { QueuePort } from "../ports/queue.js";

// Bound SQLite work and durable outstanding ranges independently of RPC log
// chunking. Retries reuse retained repair identities across restarts; shared
// transport identities also include batch membership and remaining bounds.
export const SYNC_GAP_POLICY = {
    ScanWindowBlocks: 10_000,
    CollectionsPerPass: 16,
    RetryDelayMs: 5 * 60_000,
} as const;

const SYNC_GAP_LOG_COMPONENT = "IndexerSyncGapScheduler";

export type SyncGapRange = { fromBlock: number; toBlock: number };
export type PendingSyncGapRepair = SyncGapRange & {
    repairId: string;
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
        repair: SyncGapRepairTarget,
        retryAt: number,
    ): void;
    // After fanout, conditionally advance this exact intent to its older remainder
    // or clear it. An old delivery cannot advance a changed anchor or range.
    recordRepairProgress(input: {
        chainId: number;
        repair: SyncGapRepairTarget;
        remaining: SyncGapRange | null;
        retryAt: number;
    }): void;
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
        const repairs: SyncGapRepairTarget[] = [];
        for (const collection of collections) {
            this.afterCollectionId = collection.id;
            try {
                const repair = this.scanCollection(collection, headBlock);
                if (repair) repairs.push(repair);
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
        for (const batch of planSyncGapRepairBatches(
            repairs,
            this.options.batchSize,
        )) {
            // Membership and remaining bounds determine a stable transport ID.
            // The per-collection rows already own every intent before publication.
            const identity = createHash("sha256")
                .update(JSON.stringify(batch))
                .digest("hex");
            const job: JobEnvelope<BackfillSyncPayload> = {
                jobId: `sync:gap:batch:${this.options.chainId}:${identity}`,
                kind: SYNC_JOB_KIND.BackfillRange,
                queue: QUEUE_NAMES.BackfillSync,
                chainId: this.options.chainId,
                attempt: 0,
                scheduledAt: this.now(),
                payload: {
                    ...batch,
                    source: BACKFILL_SOURCE.GapRepair,
                    orderMaintenancePolicy:
                        BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
                },
            };
            try {
                await this.queue.publish(QUEUE_NAMES.BackfillSync, job);
                for (const repair of batch.repairs)
                    this.store.deferRetry(
                        this.options.chainId,
                        repair,
                        this.now() + this.retryDelayMs,
                    );
                logger.info("Collection gap repair batch scheduled", {
                    component: SYNC_GAP_LOG_COMPONENT,
                    action: "schedule",
                    chainId: this.options.chainId,
                    collectionIds: batch.repairs.map(
                        (repair) => repair.collectionId,
                    ),
                    jobId: job.jobId,
                    fromBlock: batch.fromBlock,
                    toBlock: batch.toBlock,
                });
            } catch (error) {
                logger.warn("Collection gap repair batch publication failed", {
                    component: SYNC_GAP_LOG_COMPONENT,
                    action: "schedule",
                    chainId: this.options.chainId,
                    jobId: job.jobId,
                    error: String(error),
                });
            }
        }
    }

    private scanCollection(
        collection: CollectionRecord,
        headBlock: number,
    ): SyncGapRepairTarget | null {
        const window = collection.gapRepairWindow(headBlock);
        if (!window) return null;
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
                          repairId: `sync:gap:${chainId}:${collection.id}:${randomUUID()}`,
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
            return null;
        return {
            collectionId: collection.id,
            repairId: pending.repairId,
            anchorBlock: progress.anchorBlock,
            fromBlock: pending.fromBlock,
            toBlock: pending.toBlock,
        };
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
    if (!collection) return false;
    const repair = readSyncGapRepairTargets(job, store).find(
        (target) => target.collectionId === collection.id,
    );
    return (
        !!repair &&
        isCurrentRepairTarget(job.chainId, repair, collection, store)
    );
}

function isCurrentRepairTarget(
    chainId: number,
    repair: SyncGapRepairTarget,
    collection: CollectionRecord,
    store: Pick<SyncGapStorePort, "getProgress">,
): boolean {
    if (chainId !== collection.chainId) return false;
    const window = collection.gapRepairWindow(repair.toBlock);
    if (
        !window ||
        repair.anchorBlock !== window.fromBlock ||
        repair.fromBlock < window.fromBlock
    )
        return false;
    const progress = store.getProgress(collection.chainId, collection.id);
    return (
        progress?.anchorBlock === window.fromBlock &&
        progress.pending?.repairId === repair.repairId &&
        progress.pending.fromBlock === repair.fromBlock &&
        progress.pending.toBlock === repair.toBlock
    );
}

type GapRepairCollectionsPort = {
    getCollection(
        chainId: number,
        collectionId: number,
    ): CollectionRecord | null;
};

export function resolveCurrentSyncGapRepairs(
    job: JobEnvelope<BackfillSyncPayload>,
    collections: GapRepairCollectionsPort,
    store: Pick<SyncGapStorePort, "getProgress">,
): { repair: SyncGapRepairTarget; collection: CollectionRecord }[] {
    const current: {
        repair: SyncGapRepairTarget;
        collection: CollectionRecord;
    }[] = [];
    for (const repair of readSyncGapRepairTargets(job, store)) {
        const collection = collections.getCollection(
            job.chainId,
            repair.collectionId,
        );
        if (
            collection &&
            isCurrentRepairTarget(job.chainId, repair, collection, store)
        )
            current.push({ repair, collection });
    }
    return current;
}

function readSyncGapRepairTargets(
    job: JobEnvelope<BackfillSyncPayload>,
    store: Pick<SyncGapStorePort, "getProgress">,
): SyncGapRepairTarget[] {
    const decoded = decodeBackfillSyncJob(job);
    if (decoded?.payload.source !== BACKFILL_SOURCE.GapRepair) return [];
    if (decoded.payload.repairs !== undefined) return decoded.payload.repairs;
    // Old queued jobs use their collection-scoped envelope as repair identity.
    // New jobs always carry explicit members, even for one collection.
    if (decoded.collectionId === undefined) return [];
    const progress = store.getProgress(decoded.chainId, decoded.collectionId);
    return progress
        ? [
              {
                  collectionId: decoded.collectionId,
                  repairId: decoded.jobId,
                  anchorBlock: progress.anchorBlock,
                  fromBlock: decoded.payload.fromBlock,
                  toBlock: decoded.payload.toBlock,
              },
          ]
        : [];
}

// The runtime invokes this inside its current-state execution gate. Reloading
// here prevents jobs waiting behind another backfill from using stale liveness
// or anchor state. Completion follows the entire sync and fanout operation.
export async function executeSyncGapRepair(
    job: JobEnvelope<BackfillSyncPayload>,
    collections: GapRepairCollectionsPort,
    store: Pick<SyncGapStorePort, "getProgress" | "recordRepairProgress">,
    syncAndPublish: (
        collections: CollectionRecord[],
        sources: DomainSyncSource[],
    ) => Promise<void>,
    now: () => number = Date.now,
): Promise<boolean> {
    const current = resolveCurrentSyncGapRepairs(job, collections, store);
    if (!current.length) return false;
    await syncAndPublish(
        current.map((target) => target.collection),
        current.map(({ repair }) => ({
            fanoutId: `${job.jobId}:collection:${repair.collectionId}`,
            sourceJobId: job.jobId,
            sourceKind: job.kind,
            collectionId: repair.collectionId,
        })),
    );
    for (const { repair } of current) {
        store.recordRepairProgress({
            chainId: job.chainId,
            repair,
            remaining: remainingSyncGapRepairRange(
                repair,
                job.payload.fromBlock,
            ),
            retryAt: now(),
        });
    }
    return true;
}
