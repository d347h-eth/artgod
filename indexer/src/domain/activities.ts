import {
    ACTIVITY_KIND,
    ACTIVITY_SCOPE_KIND,
    ACTIVITY_SOURCE_KIND,
    type ActivityKind,
    type ActivityScopeKind,
    type ActivitySourceKind,
} from "@artgod/shared/types";

export {
    ACTIVITY_KIND,
    ACTIVITY_SCOPE_KIND,
    ACTIVITY_SOURCE_KIND,
    type ActivityKind,
    type ActivityScopeKind,
    type ActivitySourceKind,
};

export const ACTIVITY_PROJECTION_STATE = {
    Open: "open",
    Closed: "closed",
} as const;

/**
 * Internal lifecycle state for the activities projection.
 *
 * `open` does not mean "visible" or "successful". It means this row is still
 * the current active create-row for a coalescible offchain activity stream,
 * currently listings and bids. While a row stays open, small reprices can
 * update it in place instead of creating new history rows, and a later sale or
 * cancel can terminate it.
 *
 * `closed` means the row is historical and should no longer be mutated by the
 * projector. Transfers, sales, explicit cancel rows, and superseded listing/bid
 * create rows are all closed.
 */
export type ActivityProjectionState =
    (typeof ACTIVITY_PROJECTION_STATE)[keyof typeof ACTIVITY_PROJECTION_STATE];

/**
 * Product-facing source attribution for an activity row.
 *
 * This answers "where did this activity come from?" for feed consumers. It is
 * not the same thing as the projector's raw-event idempotency key.
 *
 * Examples:
 * - `{ sourceKind: "onchain", sourceName: "seaport" }` for a sale derived from fills
 * - `{ sourceKind: "offchain", sourceName: "opensea" }` for a listing from the OpenSea stream
 */
export type ActivityRecord = {
    chainId: number;
    collectionId: number;
    scopeKind: ActivityScopeKind;
    kind: ActivityKind;
    contract: string;
    tokenId?: string | null;
    occurredAt: number;
    // High-level provenance for feed presentation and debugging.
    sourceKind: ActivitySourceKind;
    // Concrete producer within that source kind, e.g. "seaport" or "opensea".
    sourceName: string;
    orderId?: string | null;
    blockNumber?: number | null;
    txHash?: string | null;
    logIndex?: number | null;
    from?: string | null;
    to?: string | null;
    maker?: string | null;
    taker?: string | null;
    side?: "buy" | "sell" | null;
    amount?: string | null;
    price?: string | null;
    currency?: string | null;
    payload?: Record<string, unknown> | null;
};
