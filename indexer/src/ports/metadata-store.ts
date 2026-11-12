import type { DomainSyncContext } from "./domain-handlers.js";
import type {
    TokenMetadata,
    MetadataUpdatedToken,
} from "../domain/metadata.js";
import type {
    MetadataAttempt,
    MetadataAttribution,
    MetadataFetchOptions,
    MetadataPendingReason,
    MetadataPendingSummary,
    MetadataReadinessDecision,
    MetadataTarget,
} from "../domain/metadata-pending.js";

export type MetadataCandidate = MetadataTarget & {
    attribution: MetadataAttribution;
};

/** Owns atomic token materialization and durable retry obligations, never broker delivery. */
export interface MetadataStorePort {
    candidates(context: DomainSyncContext): Iterable<MetadataCandidate>;
    target(
        chainId: number,
        collectionId: number,
        tokenId: string,
    ): MetadataTarget | null;
    hasMetadata(target: MetadataTarget): boolean;
    // Fresh requests rearm exhausted work; coalesced active requests retain their content clock.
    begin(
        target: MetadataTarget,
        options: MetadataFetchOptions,
        now: number,
        attribution?: MetadataAttribution,
    ): MetadataAttempt | null;
    // Exhausted obligations stay durable but are excluded from automatic claims.
    claimDue(chainId: number, now: number): MetadataAttempt | null;
    renew(attempt: MetadataAttempt, now: number): void;
    defer(
        attempt: MetadataAttempt,
        reason: MetadataPendingReason,
        now: number,
        delayMs?: number,
    ): void;
    // The synchronous callback must retain required follow-ups in the same transaction.
    complete(
        attempt: MetadataAttempt,
        metadata: TokenMetadata,
        readiness: MetadataReadinessDecision,
        now: number,
        afterWrite?: (updated: MetadataUpdatedToken) => void,
    ): MetadataUpdatedToken | null;
    pendingSummary(chainId: number, now: number): MetadataPendingSummary;
}
