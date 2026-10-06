import { randomUUID } from "node:crypto";
import { logger } from "@artgod/shared/utils";
import type { CollectionRecord } from "../domain/collections.js";
import type {
    SyncGapRange,
    SyncGapProgress,
    SyncGapRepairTarget,
} from "../domain/sync-gap-repair.js";
export type {
    SyncGapRange,
    SyncGapProgress,
    PendingSyncGapRepair,
} from "../domain/sync-gap-repair.js";

// Bound local coverage work and outstanding intent independently of RPC. The
// sync runtime reads these retained rows directly; the scanner publishes nothing.
export const SYNC_GAP_POLICY = {
    ScanWindowBlocks: 10_000,
    CollectionsPerPass: 16,
} as const;

const SYNC_GAP_LOG_COMPONENT = "IndexerSyncGapScheduler";

export interface SyncGapCollectionsPort {
    listCollectionsForGapRepair(
        chainId: number,
        afterCollectionId: number,
        limit: number,
    ): CollectionRecord[];
}

export interface SyncGapStorePort {
    getProgress(chainId: number, collectionId: number): SyncGapProgress | null;
    listDue(input: {
        chainId: number;
        now: number;
        limit: number;
    }): SyncGapRepairTarget[];
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
    // In the sync commit transaction, advance this intent to its older remainder
    // or clear it. An old delivery cannot advance a changed anchor or range.
    recordRepairProgress(input: {
        chainId: number;
        repair: SyncGapRepairTarget;
        remaining: SyncGapRange | null;
        retryAt: number;
    }): boolean;
}

export interface SyncGapDetectorPort {
    scan(headBlock: number): Promise<void>;
}

export type SyncGapSchedulerOptions = {
    chainId: number;
    batchSize: number;
    scanWindowBlocks?: number;
    collectionsPerPass?: number;
    now?: () => number;
};

// Each pass visits a bounded page of collections. Each collection retains one
// outstanding repair, so slow workers cannot admit the whole missing history.
export class SyncGapScheduler implements SyncGapDetectorPort {
    private afterCollectionId = 0;
    private active: Promise<void> | null = null;
    private readonly windowSize: number;
    private readonly pageSize: number;
    private readonly now: () => number;

    constructor(
        private readonly collections: SyncGapCollectionsPort,
        private readonly store: SyncGapStorePort,
        private readonly options: SyncGapSchedulerOptions,
    ) {
        this.windowSize =
            options.scanWindowBlocks ?? SYNC_GAP_POLICY.ScanWindowBlocks;
        this.pageSize =
            options.collectionsPerPass ?? SYNC_GAP_POLICY.CollectionsPerPass;
        this.now = options.now ?? Date.now;
        for (const value of [
            options.batchSize,
            this.windowSize,
            this.pageSize,
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
                this.scanCollection(collection, headBlock);
            } catch (error) {
                // A failed collection scan must not starve other collections.
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

    private scanCollection(
        collection: CollectionRecord,
        headBlock: number,
    ): void {
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
                          repairId: `sync:gap:${chainId}:${collection.id}:${randomUUID()}`,
                          retryAt: this.now(),
                      }
                    : null,
            };
            // Retain the exact range before acquisition. Restarts reuse this row
            // until the sync commit atomically advances it with data and follow-ups.
            this.store.saveProgress(chainId, collection.id, progress);
        }
    }
}
