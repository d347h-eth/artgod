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
import type { PendingCanonicalCheck } from "../domain/canonical-check.js";
import type { ChainSyncCheckpoint } from "../domain/chain-sync.js";

/** Current-state eligibility and revision-guarded effects, inside the owning writer snapshot. */
export interface OrderValidationProjectionPort {
    /** Refresh derived views after proof and pending-demand state are committed in the same writer. */
    refreshValidationProjection(
        chainId: number,
        orderId: string,
        nowMs: number,
    ): void;
    validationCandidate(
        request: OrderValidationRequest,
    ): OrderValidationCandidate | null;
    /** Atomically applies the result and its durable block attribution. Returns the
     * resulting revision, or null when newer/current-state policy rejected it. */
    applyDemandValidation(
        claim: ClaimedOrderValidation,
        result: OrderValidationResult,
        proof: OrderValidationEvidence,
    ): number | null;
}

export interface OrderValidationDemandPort {
    /** Readiness check before joining fair validation capacity. */
    hasReady(chainId: number, now: number): boolean;
    /** Bounded, durable source-independent freshness admission. */
    scheduleDue(chainId: number, now: number): number;
    /** Retain a validator-observed mismatch through the chain owner before retry. */
    retainDispute(check: PendingCanonicalCheck): void;
    /** Needed current-order work is always main, irrespective of the hint's work class.
     * A supplied checkpoint fences transaction inclusion resolved before admission. */
    admit(
        request: OrderValidationRequest,
        now: number,
        checkpoint?: ChainSyncCheckpoint,
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
