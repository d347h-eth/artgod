import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";
import { ORDER_SOURCE_STATUS, ORDER_STATUS } from "./orders.js";

export type OrderRetentionInput = {
    validUntil: number | null;
    sourceStatus: string;
    fillabilityStatus: string;
    lastObservedAt: number;
    lastChangedAt: number;
};

export const ORDER_RETIREMENT_REASON = {
    Expired: "expired",
    Terminal: "terminal",
    SourceCancelled: "source-cancelled",
    Stale: "stale",
} as const;

export function isTerminalRetirement(reason: string): boolean {
    return (
        reason === ORDER_RETIREMENT_REASON.Terminal ||
        reason === ORDER_RETIREMENT_REASON.SourceCancelled
    );
}

/** Queue retries preserve observation time; REST snapshots use their receive time. */
export function admitsOrderObservation(
    validUntil: number | null | undefined,
    observedAt: number,
    now: number,
): boolean {
    return (
        (validUntil == null || validUntil > now) &&
        Number.isSafeInteger(observedAt) &&
        observedAt > 0 &&
        // Applies to queued observations, not to the lifetime of stored orders.
        // Fresh REST reconciliation may still discover a long-lived valid order.
        observedAt > now - POLICY.unknownOrderLifetimeSeconds &&
        observedAt <= now + POLICY.futureEventToleranceSeconds
    );
}

export function isTerminalSourceStatus(status: string): boolean {
    return (
        status === ORDER_SOURCE_STATUS.Filled ||
        status === ORDER_SOURCE_STATUS.Cancelled
    );
}

/** Temporary balance/approval failure is not terminal. Source absence is reversible. */
export function orderRetirementReason(
    order: OrderRetentionInput,
    now: number,
): string | null {
    if (order.validUntil !== null && order.validUntil <= now)
        return ORDER_RETIREMENT_REASON.Expired;
    const terminal =
        order.fillabilityStatus === ORDER_STATUS.Filled ||
        order.fillabilityStatus === ORDER_STATUS.Cancelled ||
        order.sourceStatus === ORDER_SOURCE_STATUS.Filled ||
        order.sourceStatus === ORDER_SOURCE_STATUS.Cancelled;
    if (terminal && order.lastChangedAt <= now - POLICY.orderReorgGraceSeconds)
        return ORDER_RETIREMENT_REASON.Terminal;
    if (
        order.sourceStatus === ORDER_SOURCE_STATUS.Inactive &&
        order.lastChangedAt <= now - POLICY.inactiveOrderGraceSeconds
    ) {
        return ORDER_RETIREMENT_REASON.Stale;
    }
    if (
        order.validUntil === null &&
        order.lastObservedAt <= now - POLICY.unknownOrderLifetimeSeconds
    ) {
        return ORDER_RETIREMENT_REASON.Stale;
    }
    return null;
}

/** Expiry fences its own replay; only premature terminal removal needs a marker. */
export function retirementMarkerExpiry(
    order: OrderRetentionInput,
    now: number,
): number {
    return (
        (order.validUntil ?? now + POLICY.unknownOrderLifetimeSeconds) +
        POLICY.orderReorgGraceSeconds
    );
}
