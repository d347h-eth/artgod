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

export type OrderRetirementReason =
    (typeof ORDER_RETIREMENT_REASON)[keyof typeof ORDER_RETIREMENT_REASON];

export type OrderRetirementObservation = {
    reason: OrderRetirementReason;
    /** Latest observation rejected by a reversible inactivity marker. */
    retiredAt: number;
    validUntil: number | null;
};

export type OrderRetirement = OrderRetirementObservation & {
    expiresAt: number;
};

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
): OrderRetirementReason | null {
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

/** Keep one order-level fence, not a receipt for every delivery. New expiry
 * evidence can replace an unknown-expiry fallback in either direction. */
export function mergeOrderRetirement(
    previous: OrderRetirement | undefined,
    observation: OrderRetirementObservation,
    now: number,
): OrderRetirement {
    const reason =
        previous?.reason === ORDER_RETIREMENT_REASON.SourceCancelled ||
        observation.reason === ORDER_RETIREMENT_REASON.SourceCancelled
            ? ORDER_RETIREMENT_REASON.SourceCancelled
            : previous && isTerminalRetirement(previous.reason)
              ? previous.reason
              : observation.reason;
    const retiredAt =
        previous &&
        isTerminalRetirement(previous.reason) &&
        reason === previous.reason
            ? previous.retiredAt
            : Math.max(previous?.retiredAt ?? 0, observation.retiredAt);
    // An order identity has one validity deadline. If sources disagree, do not
    // shorten an already-known cancellation deadline using weaker evidence.
    const knownExpiry = Math.max(
        knownOrderExpiry(previous?.validUntil) ?? 0,
        knownOrderExpiry(observation.validUntil) ?? 0,
    );
    const validUntil = knownExpiry > 0 ? knownExpiry : null;
    const fallback =
        previous && isTerminalRetirement(previous.reason)
            ? previous.expiresAt
            : now + POLICY.unknownOrderLifetimeSeconds;
    const expiresAt = isTerminalRetirement(reason)
        ? validUntil === null
            ? fallback
            : validUntil + POLICY.orderReorgGraceSeconds
        : Math.min(
              retiredAt + POLICY.unknownOrderLifetimeSeconds,
              validUntil ?? Infinity,
          );
    return { reason, retiredAt, validUntil, expiresAt };
}

/** Unknown or malformed optional expiry must never erase cancellation evidence. */
export function knownOrderExpiry(
    value: number | null | undefined,
): number | null {
    return value != null && Number.isSafeInteger(value) && value > 0
        ? value
        : null;
}
