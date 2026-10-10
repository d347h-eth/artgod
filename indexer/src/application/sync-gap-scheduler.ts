import { randomUUID } from "node:crypto";
import { logger } from "@artgod/shared/utils";
import type { CollectionRecord } from "../domain/collections.js";
import type {
    SyncGapRange,
    SyncGapProgress,
    SyncGapRepairTarget,
    SyncGapRepairCandidate,
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
    HeadRecheckIntervalMs: 30 * 60_000,
} as const;

const SYNC_GAP_LOG_COMPONENT = "IndexerSyncGapScheduler";

export interface SyncGapCollectionsPort {
    getCollection(
        chainId: number,
        collectionId: number,
    ): CollectionRecord | null;
    listCollectionsForGapRepair(
        chainId: number,
        afterCollectionId: number,
        limit: number,
    ): CollectionRecord[];
}

// A position in the indexed order: never-checked rows first, then check time
// and collection ID. This is traversal state, not evidence a check succeeded.
export type SyncGapHeadCheckPosition = {
    collectionId: number;
    lastHeadCheckAt: number | null;
};

export interface SyncGapStorePort {
    getProgress(chainId: number, collectionId: number): SyncGapProgress | null;
    // Read at most limit due members at the globally highest pending upper
    // bound. Older ranges wait even when that newest height is in retry backoff.
    listDueRepairsAtNewestPendingHeight(input: {
        chainId: number;
        now: number;
        limit: number;
        upperBound: number;
    }): SyncGapRepairTarget[];
    // Save only if the previously read state is still current. The scanner and
    // sync worker run in separate processes; stale scans must not replace work.
    saveProgress(input: {
        chainId: number;
        collectionId: number;
        expected: SyncGapProgress | null;
        progress: SyncGapProgress;
    }): boolean;
    // Probe due timing before reading RPC HEAD. Window eligibility is applied
    // by listHeadRechecksAfter once that fresh head is available.
    hasHeadRechecksDue(input: {
        chainId: number;
        checkedBefore: number;
    }): boolean;
    // Seek past an attempted page in check-time/collection order. Apply live
    // anchor-to-HEAD eligibility before LIMIT; no OFFSET or unbounded ID list.
    listHeadRechecksAfter(input: {
        chainId: number;
        checkedBefore: number;
        headBlock: number;
        limit: number;
        after: SyncGapHeadCheckPosition | null;
    }): SyncGapHeadCheckPosition[];
    // Returns the highest missing contiguous range, capped to batchSize, from
    // collection coverage only. Implementations must bound reads to window.
    findGap(
        chainId: number,
        collectionId: number,
        window: SyncGapRange,
        batchSize: number,
    ): SyncGapRange | null;
    // Search the full newer span without allocating its coverage rows. All
    // reads must use one coverage snapshot; cap only the returned repair range.
    findNewestGap(
        chainId: number,
        collectionId: number,
        window: SyncGapRange,
        batchSize: number,
    ): SyncGapRange | null;
    // Recheck at most batchSize blocks at the intent's upper end in one transaction.
    // Remove covered suffixes, preserving every older remainder and its scan cursor.
    // Null means stale intent or no missing block in that suffix, not a sync commit.
    reconcileRepairCoverage(input: {
        chainId: number;
        repair: SyncGapRepairTarget;
        batchSize: number;
        now: number;
    }): SyncGapRepairCandidate | null;
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
    hasCollections(): boolean;
    // Forget process-local completed searches when rollback invalidates coverage.
    resetDiscovery(): void;
    // True means another bounded discovery page/window can make progress now.
    scan(headBlock: number): Promise<boolean>;
}

export interface SyncGapHeadRecheckPort {
    hasHeadRechecksDue(): boolean;
    // Call between fetch-and-save attempts, inside the shared backfill gate.
    // Returns whether a newer repair replaced the saved scan position.
    recheckFromHead(headBlock: number): boolean;
}

export type SyncGapSchedulerOptions = {
    chainId: number;
    batchSize: number;
    scanWindowBlocks?: number;
    collectionsPerPass?: number;
    headRecheckIntervalMs?: number;
    now?: () => number;
};

type HeadCheckTraversal = {
    checkedBefore: number;
    after: SyncGapHeadCheckPosition | null;
};

// Each pass visits a bounded page of collections. Each collection retains one
// outstanding repair, so slow workers cannot admit the whole missing history.
export class SyncGapScheduler
    implements SyncGapDetectorPort, SyncGapHeadRecheckPort
{
    private afterCollectionId = 0;
    private headCheckTraversal: HeadCheckTraversal | null = null;
    private active: Promise<boolean> | null = null;
    private roundHasOlderWindows = false;
    private roundHasUnfinishedCollections = false;
    private completed = new Map<number, number>();
    private cycleCompletedAt: number | null = null;
    private restartFromHead = false;
    private readonly windowSize: number;
    private readonly pageSize: number;
    private readonly now: () => number;
    private readonly headRecheckIntervalMs: number;

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
        this.headRecheckIntervalMs =
            options.headRecheckIntervalMs ??
            SYNC_GAP_POLICY.HeadRecheckIntervalMs;
        for (const value of [
            options.batchSize,
            this.windowSize,
            this.pageSize,
            this.headRecheckIntervalMs,
        ]) {
            if (!Number.isSafeInteger(value) || value < 1)
                throw new Error(
                    "Sync gap limits must be positive safe integers",
                );
        }
    }

    hasHeadRechecksDue(): boolean {
        return this.store.hasHeadRechecksDue({
            chainId: this.options.chainId,
            checkedBefore: this.now() - this.headRecheckIntervalMs,
        });
    }

    recheckFromHead(headBlock: number): boolean {
        if (!Number.isSafeInteger(headBlock) || headBlock < 1) return false;
        const checkedBefore = this.now() - this.headRecheckIntervalMs;
        let traversal = this.headCheckTraversal ?? {
            checkedBefore,
            after: null,
        };
        let checks = this.headRechecksAfter(headBlock, traversal);
        if (!checks.length && traversal.after !== null) {
            traversal = { checkedBefore, after: null };
            checks = this.headRechecksAfter(headBlock, traversal);
        }
        // Advance even when every check fails or is skipped after selection.
        // Keep the cutoff fixed until the end so successful rows becoming due
        // again cannot prevent wrapping back to earlier unperformed checks.
        this.headCheckTraversal = checks.length
            ? { ...traversal, after: checks.at(-1)! }
            : null;
        let replaced = false;
        for (const { collectionId } of checks) {
            try {
                const collection = this.collections.getCollection(
                    this.options.chainId,
                    collectionId,
                );
                if (collection)
                    replaced =
                        this.recheckCollection(collection, headBlock) ||
                        replaced;
            } catch (error) {
                logger.warn("Collection HEAD gap check failed", {
                    component: SYNC_GAP_LOG_COMPONENT,
                    action: "head_check",
                    chainId: this.options.chainId,
                    collectionId,
                    error: String(error),
                });
            }
        }
        return replaced;
    }

    private headRechecksAfter(
        headBlock: number,
        traversal: HeadCheckTraversal,
    ): SyncGapHeadCheckPosition[] {
        return this.store.listHeadRechecksAfter({
            chainId: this.options.chainId,
            headBlock,
            limit: this.pageSize,
            ...traversal,
        });
    }

    private recheckCollection(
        collection: CollectionRecord,
        headBlock: number,
    ): boolean {
        const window = collection.gapRepairWindow(headBlock);
        if (!window) return false;
        const chainId = this.options.chainId;
        const expected = this.store.getProgress(chainId, collection.id);
        if (!expected || expected.anchorBlock !== window.fromBlock)
            return false;
        // The scheduler may have completed a HEAD scan after the due IDs were
        // selected. Reuse that check instead of repeating a large coverage read.
        if (
            expected.lastHeadCheckAt !== null &&
            expected.lastHeadCheckAt > this.now() - this.headRecheckIntervalMs
        )
            return false;
        const fromBlock = Math.max(
            window.fromBlock,
            (expected.pending?.toBlock ??
                expected.cursorBlock ??
                window.fromBlock - 1) + 1,
        );
        const gap =
            fromBlock <= headBlock
                ? this.store.findNewestGap(
                      chainId,
                      collection.id,
                      { fromBlock, toBlock: headBlock },
                      this.options.batchSize,
                  )
                : null;
        const progress = gap
            ? this.progressForGap({
                  collectionId: collection.id,
                  anchorBlock: window.fromBlock,
                  gap,
                  scannedFromBlock: fromBlock,
                  lastHeadCheckAt: this.now(),
              })
            : { ...expected, lastHeadCheckAt: this.now() };
        const saved = this.store.saveProgress({
            chainId,
            collectionId: collection.id,
            expected,
            progress,
        });
        if (saved && gap) {
            this.completed.delete(collection.id);
            this.cycleCompletedAt = null;
        }
        return saved && gap !== null;
    }

    hasCollections(): boolean {
        return (
            this.collections.listCollectionsForGapRepair(
                this.options.chainId,
                0,
                1,
            ).length > 0
        );
    }

    scan(headBlock: number): Promise<boolean> {
        if (this.active) return this.active;
        if (
            this.cycleCompletedAt !== null &&
            this.now() - this.cycleCompletedAt >= this.headRecheckIntervalMs
        )
            this.resetDiscovery();
        this.active = this.scanPage(headBlock).finally(() => {
            this.active = null;
        });
        return this.active;
    }

    resetDiscovery(): void {
        this.completed.clear();
        this.cycleCompletedAt = null;
        this.afterCollectionId = 0;
        this.roundHasOlderWindows = false;
        this.roundHasUnfinishedCollections = false;
        this.restartFromHead = true;
    }

    private async scanPage(headBlock: number): Promise<boolean> {
        if (!Number.isSafeInteger(headBlock) || headBlock < 1) return false;
        const collections = this.collections.listCollectionsForGapRepair(
            this.options.chainId,
            this.afterCollectionId,
            this.pageSize,
        );
        for (const collection of collections) {
            this.afterCollectionId = collection.id;
            try {
                this.roundHasOlderWindows =
                    this.scanCollection(collection, headBlock) ||
                    this.roundHasOlderWindows;
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
        if (collections.length === this.pageSize) return true;
        this.afterCollectionId = 0;
        this.restartFromHead = false;
        const more = this.roundHasOlderWindows;
        if (!this.roundHasUnfinishedCollections)
            this.cycleCompletedAt ??= this.now();
        this.roundHasOlderWindows = false;
        this.roundHasUnfinishedCollections = false;
        return more;
    }

    private scanCollection(
        collection: CollectionRecord,
        headBlock: number,
    ): boolean {
        const window = collection.gapRepairWindow(headBlock);
        if (!window) return false;
        const chainId = this.options.chainId;
        const expected = this.store.getProgress(chainId, collection.id);
        let progress = expected;
        if (!progress || progress.anchorBlock !== window.fromBlock) {
            this.completed.delete(collection.id);
            this.cycleCompletedAt = null;
            progress = {
                anchorBlock: window.fromBlock,
                cursorBlock: null,
                pending: null,
                lastHeadCheckAt: null,
            };
        }
        // A null cursor also marks a finished search. Keep that meaning for
        // this cycle instead of restarting it while peers visit older windows.
        if (this.completed.get(collection.id) === window.fromBlock)
            return false;
        if (!progress.pending) {
            const cursor = this.restartFromHead ? null : progress.cursorBlock;
            const end = Math.min(cursor ?? headBlock, headBlock);
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
            // A scan starting at HEAD already checked everything above the new
            // cursor. Continuing older history must not postpone the next check.
            const lastHeadCheckAt =
                cursor === null ? this.now() : progress.lastHeadCheckAt;
            progress = this.progressForGap({
                collectionId: collection.id,
                anchorBlock: window.fromBlock,
                gap,
                lastHeadCheckAt,
                scannedFromBlock: scanWindow.fromBlock,
            });
            // Retain the exact range before acquisition. Restarts reuse this row
            // until the sync commit atomically advances it with data and follow-ups.
            const saved = this.store.saveProgress({
                chainId,
                collectionId: collection.id,
                expected,
                progress,
            });
            if (!saved) {
                this.roundHasUnfinishedCollections = true;
                return false;
            }
            if (progress.cursorBlock === null)
                this.completed.set(collection.id, window.fromBlock);
            else {
                this.roundHasUnfinishedCollections = true;
                this.cycleCompletedAt = null;
            }
            return !progress.pending && progress.cursorBlock !== null;
        }
        if (progress.cursorBlock === null)
            this.completed.set(collection.id, window.fromBlock);
        else {
            this.roundHasUnfinishedCollections = true;
            this.cycleCompletedAt = null;
        }
        return false;
    }

    private progressForGap({
        collectionId,
        anchorBlock,
        gap,
        lastHeadCheckAt,
        scannedFromBlock,
    }: {
        collectionId: number;
        anchorBlock: number;
        gap: SyncGapRange | null;
        lastHeadCheckAt: number | null;
        scannedFromBlock: number;
    }): SyncGapProgress {
        const nextCursor = (gap?.fromBlock ?? scannedFromBlock) - 1;
        return {
            anchorBlock,
            cursorBlock: nextCursor < anchorBlock ? null : nextCursor,
            pending: gap
                ? {
                      ...gap,
                      repairId: `sync:gap:${this.options.chainId}:${collectionId}:${randomUUID()}`,
                      retryAt: this.now(),
                  }
                : null,
            lastHeadCheckAt,
        };
    }
}
