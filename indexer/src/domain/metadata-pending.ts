import type { TokenMetadata, TokenStandard } from "./metadata.js";

// Resource bounds are generic; extensions may separately bound incomplete-content retries.
export const METADATA_PENDING_POLICY = Object.freeze({
    pollMs: 1_000,
    concurrency: 2,
    obsoletePageSize: 16,
    leaseMs: 120_000,
    renewMs: 30_000,
    retryBaseMs: 15_000,
    retryMaxMs: 3_600_000,
});

export const METADATA_PENDING_REASON = {
    Fetching: "fetching",
    UriUnavailable: "uri_unavailable",
    FetchUnavailable: "fetch_unavailable",
    NotReady: "not_ready",
    Interrupted: "interrupted",
    Deferred: "deferred",
    AwaitingOwnership: "awaiting_ownership",
} as const;
export type MetadataPendingReason =
    (typeof METADATA_PENDING_REASON)[keyof typeof METADATA_PENDING_REASON];

export const METADATA_PENDING_LOG = {
    Component: "MetadataPending",
    Attempt: "Pending metadata attempt completed",
    Assessed: "Metadata response readiness assessed",
    NotReady: "Metadata response not ready",
    PollFailed: "Pending metadata poll failed",
} as const;

export const METADATA_PENDING_METRIC = {
    Attempts: "metadata.pending.attempts",
    Backlog: "metadata.pending.backlog",
    OldestAge: "metadata.pending.oldest_age_ms",
    Exhausted: "metadata.pending.exhausted",
} as const;

/** Absolute elapsed ages, strictly increasing from zero, for successful but incomplete responses. */
export type MetadataContentRetryPolicy = {
    attemptAgesMs: readonly number[];
};

export type MetadataContentRetryDecision = {
    pendingSince: number;
    /** Null stops automatic work only after a fresh unsuccessful content assessment. */
    nextAttemptAt: number | null;
};

export type MetadataReadinessDecision =
    | { ready: true }
    | { ready: false; contentRetry?: MetadataContentRetryDecision };

export type MetadataPendingSummary = {
    pending: number;
    exhausted: number;
    oldestAgeMs: number;
};

/** Missed milestones do not cause catch-up bursts or substitute for a final content check. */
export function decideMetadataContentRetry(
    pendingSince: number | null,
    now: number,
    policy: MetadataContentRetryPolicy,
): MetadataContentRetryDecision {
    const startedAt = pendingSince ?? now;
    const age = Math.max(0, now - startedAt);
    const nextAge = policy.attemptAgesMs.find((candidate) => candidate > age);
    return {
        pendingSince: startedAt,
        nextAttemptAt: nextAge === undefined ? null : startedAt + nextAge,
    };
}

export type MetadataFetchOptions = {
    imageSourceField?: string | null;
    animationSourceField?: string | null;
};

export type MetadataTarget = {
    chainId: number;
    collectionId: number;
    contract: string;
    tokenId: string;
    standard: TokenStandard;
};

export type MetadataAttribution = {
    blockNumber?: number | null;
    blockHash?: string | null;
    blockTimestamp?: number | null;
    txHash?: string | null;
    logIndex?: number | null;
};

// The unique owner fences superseding observations, lease recovery and delete/reinsert ABA.
export type MetadataAttempt = {
    target: MetadataTarget;
    owner: string;
    attempts: number;
    /** Prior hosting failures; local allocation/presence waits never increase backoff. */
    failures: number;
    contentPendingAt: number | null;
    options: MetadataFetchOptions;
    checkpoint: number;
    retry: boolean;
    attribution?: MetadataAttribution;
};

export interface MetadataReadinessPort {
    isReady(target: MetadataTarget, metadata: TokenMetadata): boolean;
    contentRetryPolicy?(
        target: MetadataTarget,
    ): MetadataContentRetryPolicy | null;
}

/** Deterministic per-token jitter spreads outages without retaining an unbounded timer set. */
export function metadataRetryDelay(attempt: MetadataAttempt): number {
    const exponent = Math.min(18, Math.max(0, attempt.failures));
    const ceiling = Math.min(
        METADATA_PENDING_POLICY.retryMaxMs,
        METADATA_PENDING_POLICY.retryBaseMs * 2 ** exponent,
    );
    let hash = 2166136261;
    for (const char of `${attempt.target.collectionId}:${attempt.target.tokenId}:${attempt.attempts}`)
        hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    return Math.round(ceiling * (0.75 + (hash % 1001) / 4000));
}

export function isMetadataHostingFailure(
    reason: MetadataPendingReason,
): boolean {
    return (
        reason === METADATA_PENDING_REASON.UriUnavailable ||
        reason === METADATA_PENDING_REASON.FetchUnavailable ||
        reason === METADATA_PENDING_REASON.NotReady
    );
}
