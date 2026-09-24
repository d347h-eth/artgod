import type {
    ClaimedOrderValidation,
    OrderValidationCandidate,
    OrderValidationDemand,
    OrderValidationProof,
    OrderValidationRequest,
    ORDER_VALIDATION_DEMAND_OUTCOME,
} from "../domain/order-validation-demand.js";
import type { OrderValidationResult } from "../domain/orders.js";

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
    admit(
        request: OrderValidationRequest,
        now: number,
    ): (typeof ORDER_VALIDATION_DEMAND_OUTCOME)[keyof typeof ORDER_VALIDATION_DEMAND_OUTCOME];
    get(chainId: number, orderId: string): OrderValidationDemand | null;
    /** Selects/claims bounded work atomically; only one executor owns each revision/generation. */
    claimNext(
        chainId: number,
        owner: string,
        now: number,
    ): ClaimedOrderValidation | null;
    renew(claim: ClaimedOrderValidation, now: number): boolean;
    /** Commits order effects and captured-generation coverage together. New demand survives. */
    complete(
        claim: ClaimedOrderValidation,
        result: OrderValidationResult,
        proof: OrderValidationProof,
        now: number,
    ): void;
    fail(claim: ClaimedOrderValidation, error: unknown, now: number): void;
}
