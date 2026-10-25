import {
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
    type OrderRecord,
    type OrderValidationResult,
} from "./orders.js";
import { ORDER_VALIDATION_BATCH_POLICY } from "./order-validation-policy.js";
import type { SyncBlockHeader, ValidationCheckpoint } from "./chain-sync.js";

export const ORDER_VALIDATION_DEMAND_POLICY = Object.freeze({
    leaseMs: 120_000,
    renewEveryMs: 30_000,
    pollMs: 1_000,
    batchOrders: ORDER_VALIDATION_BATCH_POLICY.maxOrders,
    retryBaseMs: 1_000,
    retryMaxMs: 60_000,
    isolateAfterFailures: 2,
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
    /** Source identity is local durable admission, never a source timestamp. */
    observationKey: string | null;
    /** Canonical events carry an accepted identity, not just a claimed height. */
    minimumBlock: number | null;
    minimumBlockHash: string | null;
    /** Scope expansion may reuse an already retained local source admission. */
    admissionSequence?: number;
    /** Composite source/event demand is independent of historical projection gating. */
    anchorIndependent?: boolean;
};
export type OrderValidationCandidate = { order: OrderRecord; revision: number };
export type OrderValidationDemand = OrderValidationRequest & {
    /** Local admission time for queue-age diagnostics only. */
    requiredAt: number;
    admissionSequence: number;
    generation: number;
    revision: number;
    pending: boolean;
    /** Canonical observations also request validation without a historical trigger gate. */
    anchorIndependent: boolean;
    proofRevision: number | null;
    proofAt: number | null;
    proofBlock: number | null;
    proofBlockHash: string | null;
    proofAdmissionSequence: number;
    proofChainRevision: number | null;
    leaseOwner: string | null;
    leaseVersion: number;
    leaseUntil: number;
    failures: number;
};
export type ClaimedOrderValidation = {
    demand: OrderValidationDemand;
    candidate: OrderValidationCandidate;
    checkpoint: ValidationCheckpoint;
};
export type OrderValidationProof = {
    observedAt: number;
    block: SyncBlockHeader;
};
export type OrderValidationEvidence = OrderValidationProof & {
    checkpoint: ValidationCheckpoint;
    /** Highest local admission covered by the checkpoint sampling barrier. */
    admissionSequence: number;
};

/** Event requests use identities accepted by the chain coordinator. */
export function eventValidationRequest(
    chainId: number,
    orderId: string,
    blockNumber: number,
    blockHash: string,
): OrderValidationRequest {
    return {
        chainId,
        orderId,
        observationKey: null,
        minimumBlock: blockNumber,
        minimumBlockHash: blockHash,
    };
}

/** The source owner supplies a stable identity after duplicate/change classification. */
export function observedOrderValidationRequest(
    chainId: number,
    orderId: string,
    observationKey: string,
): OrderValidationRequest {
    return {
        chainId,
        orderId,
        observationKey,
        minimumBlock: null,
        minimumBlockHash: null,
    };
}

export type OrderValidationClaimBatch = {
    claims: ClaimedOrderValidation[];
    scanned: number;
    resolvedUnneeded: number;
    oldestRequiredAt: number | null;
    checkpoint: ValidationCheckpoint | null;
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

/** Membership of earlier event identities is checked by the persistence owner. */
export function validationProofSatisfies(
    proof: OrderValidationEvidence,
    request: Pick<
        OrderValidationDemand,
        "admissionSequence" | "minimumBlock" | "minimumBlockHash"
    >,
): boolean {
    return (
        proof.admissionSequence >= request.admissionSequence &&
        (request.minimumBlock === null ||
            proof.block.number > request.minimumBlock ||
            (proof.block.number === request.minimumBlock &&
                proof.block.hash === request.minimumBlockHash))
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
    chainRevision: number,
): boolean {
    return (
        demand.proofRevision === revision &&
        demand.proofChainRevision === chainRevision &&
        demand.proofAt !== null &&
        demand.proofBlock !== null &&
        demand.proofBlockHash !== null &&
        (request.observationKey === null ||
            (request.observationKey === demand.observationKey &&
                demand.proofAdmissionSequence >= demand.admissionSequence) ||
            (request.admissionSequence !== undefined &&
                demand.proofAdmissionSequence >= request.admissionSequence)) &&
        (request.minimumBlock === null ||
            demand.proofBlock > request.minimumBlock ||
            (demand.proofBlock === request.minimumBlock &&
                demand.proofBlockHash === request.minimumBlockHash))
    );
}

/** Replays retain their identity; a useful source change or stronger event adds a generation. */
export function advancesValidationDemand(
    current: OrderValidationDemand,
    revision: number,
    request: OrderValidationRequest,
): boolean {
    return (
        !current.pending ||
        current.revision !== revision ||
        (request.observationKey !== null &&
            request.observationKey !== current.observationKey) ||
        (request.admissionSequence !== undefined &&
            request.admissionSequence > current.admissionSequence) ||
        (request.minimumBlock !== null &&
            (current.minimumBlock === null ||
                request.minimumBlock > current.minimumBlock ||
                (request.minimumBlock === current.minimumBlock &&
                    request.minimumBlockHash !== current.minimumBlockHash)))
    );
}

export function assertOrderValidationRequest(
    request: OrderValidationRequest,
): void {
    const source =
        typeof request.observationKey === "string" &&
        request.observationKey.length > 0;
    const canonical =
        Number.isSafeInteger(request.minimumBlock) &&
        request.minimumBlock! >= 0 &&
        typeof request.minimumBlockHash === "string" &&
        /^0x[0-9a-f]{64}$/i.test(request.minimumBlockHash);
    if (
        !Number.isSafeInteger(request.chainId) ||
        request.chainId <= 0 ||
        !request.orderId ||
        (source
            ? request.minimumBlock !== null || request.minimumBlockHash !== null
            : request.observationKey !== null || !canonical) ||
        (request.admissionSequence !== undefined &&
            (!source ||
                !Number.isSafeInteger(request.admissionSequence) ||
                request.admissionSequence < 1))
    )
        throw new Error("Invalid order validation demand");
}

/** Bounded retry for uncertain validation, independent of waiting for sync. */
export function orderValidationRetryDelay(failures: number): number {
    return Math.min(
        ORDER_VALIDATION_DEMAND_POLICY.retryMaxMs,
        ORDER_VALIDATION_DEMAND_POLICY.retryBaseMs *
            2 ** Math.min(Math.max(0, failures - 1), 16),
    );
}
