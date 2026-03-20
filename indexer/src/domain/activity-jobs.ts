import type {
    ActivityKind,
    ActivityScopeKind,
    ActivitySourceKind,
} from "./activities.js";

export const ACTIVITY_JOB_KIND = {
    Upsert: "activities.upsert",
} as const;

/**
 * Raw upstream event identity for projector idempotency.
 *
 * This is not the same as the feed row's user-facing source attribution. These
 * fields identify the exact upstream event we consumed so repeated delivery of
 * the same source event can be ignored safely, and so coalescing logic can keep
 * updating the already-projected row instead of duplicating it.
 */
export type ActivityUpsertPayload = {
    chainId: number;
    collectionId: number;
    scopeKind: ActivityScopeKind;
    kind: ActivityKind;
    contract: string;
    tokenId?: string | null;
    occurredAt: number;
    sourceKind: Exclude<ActivitySourceKind, "onchain">;
    sourceName: string;
    // Upstream event id/dedupe key within the producer identified above.
    sourceEventKey: string;
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
