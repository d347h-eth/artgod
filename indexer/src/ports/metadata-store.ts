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
    begin(
        target: MetadataTarget,
        options: MetadataFetchOptions,
        now: number,
        attribution?: MetadataAttribution,
    ): MetadataAttempt | null;
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
        ready: boolean,
        now: number,
        afterWrite?: (updated: MetadataUpdatedToken) => void,
    ): MetadataUpdatedToken | null;
    pendingSummary(
        chainId: number,
        now: number,
    ): { pending: number; oldestAgeMs: number };
}
