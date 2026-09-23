import { ACTIVITY_KIND, ACTIVITY_SOURCE_KIND } from "../types/activity-feed.js";
import recoveryRuntime from "./recovery-runtime.json" with { type: "json" };

/** Market display/history budgets, not wallet, trading-intent or artwork retention. */
export const MARKET_DATA_STORAGE_POLICY = Object.freeze({
    futureEventToleranceSeconds: 5 * 60,
    orderRevalidationSeconds: 5 * 60,
    inactiveOrderGraceSeconds: 60 * 60,
    unknownOrderLifetimeSeconds: 24 * 60 * 60,
    orderReorgGraceSeconds: 60 * 60,
    maintenanceBatchRows: 500,
    // Online work yields between batches and stops after this elapsed budget.
    maintenancePassBudgetMs: 2_000,
    // Shared cadence for order cleanup and WAL diagnostics on the user's machine.
    maintenanceIntervalMs: 20 * 60 * 1_000,
    // Unfinished cleanup yields for 30 seconds, rather than waiting another full cycle.
    maintenanceContinuationDelayMs: 30 * 1_000,
    // The 52 GiB Qubes copy required about 24 minutes; leave cold-I/O headroom.
    recoveryBudgetMs: recoveryRuntime.workBudgetMs,
    recoveryMinFreeBytes: 1_024 * 1_024 * 1_024,
    compactionMinReclaimBytes: 1_024 * 1_024 * 1_024,
    // Early diagnostic thresholds, separate from recovery and journal reuse.
    diskFreeWarningBytes: 20 * 1_024 * 1_024 * 1_024,
    walSizeWarningBytes: 2 * 1_024 * 1_024 * 1_024,
    storageWarningRepeatSeconds: 6 * 60 * 60,
    utcDaySeconds: 86_400,
});

/** Persisted recovery vocabulary is shared by the task, tests and diagnostics. */
export const MARKET_DATA_RECOVERY_STAGE = {
    ListingReset: "listing-reset",
    Activities: "activities",
    Orders: "orders",
    Receipts: "receipts",
    Indexes: "indexes",
    Checkpoint: "checkpoint",
    Complete: "complete",
} as const;

export type MarketDataRecoveryStage =
    (typeof MARKET_DATA_RECOVERY_STAGE)[keyof typeof MARKET_DATA_RECOVERY_STAGE];

/** Only listing creation has a retained offchain feed use case. */
export function retainsOffchainActivity(kind: string): boolean {
    return kind === ACTIVITY_KIND.ListingCreated;
}

export function admitsListingObservation(
    occurredAt: number,
    nowSeconds: number,
): boolean {
    return (
        Number.isSafeInteger(occurredAt) &&
        occurredAt > 0 &&
        occurredAt <=
            nowSeconds + MARKET_DATA_STORAGE_POLICY.futureEventToleranceSeconds
    );
}

/** A daily feed identity is independent of orders, currencies and transport aliases. */
export function listingDayIdentity(
    collectionId: number,
    tokenId: string,
    maker: string,
    occurredAt: number,
): string {
    return `${ACTIVITY_SOURCE_KIND.Offchain}:${ACTIVITY_KIND.ListingCreated}:${collectionId}:${tokenId}:${maker.toLowerCase()}:${Math.floor(occurredAt / MARKET_DATA_STORAGE_POLICY.utcDaySeconds)}`;
}
