import type {
    ClaimedOrderValidation,
    OrderValidationCandidate,
    OrderValidationDemand,
    OrderValidationEvidence,
    OrderValidationRequest,
    OrderValidationClaimBatch,
    OrderValidationCompletion,
    OrderValidationCompletionCounts,
    ORDER_VALIDATION_DEMAND_OUTCOME,
} from "../domain/order-validation-demand.js";
import type { OrderValidationResult } from "../domain/orders.js";
import type { ChainSyncCheckpoint } from "../domain/chain-sync.js";

/** Current-state eligibility and revision-guarded effects, inside the owning writer snapshot. */
export interface OrderValidationProjectionPort {
    validationCandidate(
        request: OrderValidationRequest,
    ): OrderValidationCandidate | null;
    /** Returns the resulting revision, or null when newer/current-state policy rejected it. */
    applyDemandValidation(
        claim: ClaimedOrderValidation,
        result: OrderValidationResult,
    ): number | null;
}

export interface OrderValidationDemandPort {
    captureSyncCheckpoint(chainId: number): ChainSyncCheckpoint;
    /** Same-order, same-canonical-history validation; does not consume pending newer demand. */
    isCovered(request: OrderValidationRequest, revision: number): boolean;
    /** Shares the maker checkpoint transaction. Keep newer unmet observations pending. */
    recordValidation(
        request: OrderValidationRequest,
        revision: number,
        evidence: OrderValidationEvidence,
        now: number,
    ): void;
    /** Needed current-order work is always main, irrespective of the hint's work class. */
    admit(
        request: OrderValidationRequest,
        now: number,
    ): (typeof ORDER_VALIDATION_DEMAND_OUTCOME)[keyof typeof ORDER_VALIDATION_DEMAND_OUTCOME];
    /** Admit a known failed order with isolated retry/backoff, without recording proof.
     * Participates in the caller's checkpoint transaction on the same database. */
    defer(
        request: OrderValidationRequest,
        error: string,
        now: number,
    ): (typeof ORDER_VALIDATION_DEMAND_OUTCOME)[keyof typeof ORDER_VALIDATION_DEMAND_OUTCOME];
    get(chainId: number, orderId: string): OrderValidationDemand | null;
    /** Selects/claims bounded work atomically; only one executor owns each revision/generation. */
    claimBatch(
        chainId: number,
        owner: string,
        now: number,
    ): OrderValidationClaimBatch;
    renew(claim: ClaimedOrderValidation, now: number): boolean;
    /** Commits order effects and captured-generation coverage together. New demand survives. */
    completeBatch(
        completions: readonly OrderValidationCompletion[],
        proof: OrderValidationEvidence,
        now: number,
    ): OrderValidationCompletionCounts;
    /** Release unconsumed claims without inventing validation coverage or a failure. */
    release(claims: readonly ClaimedOrderValidation[], now: number): number;
    fail(
        claims: readonly ClaimedOrderValidation[],
        error: unknown,
        now: number,
    ): number;
}
