import {
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
    type OrderRecord,
    type OrderValidationResult,
} from "./orders.js";
import { ORDER_VALIDATION_BATCH_POLICY } from "./order-validation-policy.js";

export const ORDER_VALIDATION_DEMAND_POLICY = Object.freeze({
    leaseMs: 120_000,
    renewEveryMs: 30_000,
    pollMs: 1_000,
    batchOrders: ORDER_VALIDATION_BATCH_POLICY.maxOrders,
    retryBaseMs: 1_000,
    retryMaxMs: 60_000,
});

export const ORDER_VALIDATION_DEMAND_OUTCOME = {
    Unneeded: "unneeded",
    Covered: "covered",
    Pending: "pending",
} as const;

export const ORDER_VALIDATION_DEMAND_LOG = {
    Component: "OrderValidationDemand",
    Progress: "Order validation demand progress",
    BatchFailed: "Order validation demand failed",
    PollFailed: "Order validation demand poll failed",
} as const;

export type OrderValidationRequest = {
    chainId: number;
    orderId: string;
    /** Required observation coverage in epoch milliseconds, separate from DB freshness. */
    requiredAt: number;
    minimumBlock: number | null;
};
export type OrderValidationCandidate = { order: OrderRecord; revision: number };
export type OrderValidationDemand = OrderValidationRequest & {
    generation: number;
    revision: number;
    pending: boolean;
    /** Canonical observations also request validation without a historical trigger gate. */
    anchorIndependent: boolean;
    proofRevision: number | null;
    proofAt: number | null;
    proofBlock: number | null;
    leaseOwner: string | null;
    leaseVersion: number;
    leaseUntil: number;
    failures: number;
};
export type ClaimedOrderValidation = {
    demand: OrderValidationDemand;
    candidate: OrderValidationCandidate;
};
export type OrderValidationProof = { observedAt: number; blockNumber: number };

export type OrderValidationClaimBatch = {
    claims: ClaimedOrderValidation[];
    scanned: number;
    resolvedUnneeded: number;
    oldestRequiredAt: number | null;
};

export type OrderValidationCompletion = {
    claim: ClaimedOrderValidation;
    result: OrderValidationResult;
};

export type OrderValidationCompletionCounts = {
    applied: number;
    covered: number;
    resolvedUnneeded: number;
    followup: number;
    lostClaims: number;
};

export function validationProofSatisfies(
    proof: OrderValidationProof,
    request: OrderValidationRequest,
): boolean {
    return (
        proof.observedAt >= request.requiredAt &&
        (request.minimumBlock === null ||
            proof.blockNumber >= request.minimumBlock)
    );
}

/** A recovered balance never revives source/protocol terminal state. */
export function needsCurrentOrderValidation(
    order: OrderRecord,
    nowSeconds: number,
): boolean {
    return (
        order.kind === "seaport" &&
        order.sourceStatus === ORDER_SOURCE_STATUS.Active &&
        (order.validUntil == null || order.validUntil > nowSeconds) &&
        order.fillabilityStatus !== ORDER_STATUS.Filled &&
        order.fillabilityStatus !== ORDER_STATUS.Cancelled &&
        order.fillabilityStatus !== ORDER_STATUS.Expired
    );
}

export function validationProofCovers(
    demand: OrderValidationDemand,
    revision: number,
    request: OrderValidationRequest,
): boolean {
    return (
        demand.proofRevision === revision &&
        demand.proofAt !== null &&
        demand.proofAt >= request.requiredAt &&
        demand.proofBlock !== null &&
        (request.minimumBlock === null ||
            demand.proofBlock >= request.minimumBlock)
    );
}

/** A compatible repeated hint adds no write; newer coverage/revision retains a follow-up. */
export function advancesValidationDemand(
    current: OrderValidationDemand,
    revision: number,
    request: OrderValidationRequest,
): boolean {
    return (
        !current.pending ||
        current.revision !== revision ||
        (request.minimumBlock === null && !current.anchorIndependent) ||
        request.requiredAt > current.requiredAt ||
        (request.minimumBlock !== null &&
            (current.minimumBlock === null ||
                request.minimumBlock > current.minimumBlock))
    );
}

export function assertOrderValidationRequest(
    request: OrderValidationRequest,
): void {
    if (
        !Number.isSafeInteger(request.chainId) ||
        request.chainId <= 0 ||
        !request.orderId ||
        !Number.isSafeInteger(request.requiredAt) ||
        request.requiredAt < 0 ||
        (request.minimumBlock !== null &&
            (!Number.isSafeInteger(request.minimumBlock) ||
                request.minimumBlock < 0))
    )
        throw new Error("Invalid order validation demand");
}
