import type { OrderUpdateByMakerPayload } from "./order-jobs.js";
import type { OrderRecord, OrderValidationResult } from "./orders.js";
import type { QueueDeliveryOrigin } from "./jobs.js";
import type { JobEnvelope, QueuePublication } from "./jobs.js";
import { ORDER_JOB_KIND } from "./order-jobs.js";
import type { QueueName } from "./queues.js";
import { makerUpdateQueue } from "./order-processing.js";
import type { QueueOutboxStatus } from "./queue-outbox.js";
import {
    MAKER_TRIGGER_SCOPE,
    TOKEN_SCOPED_MAKER_TRIGGER_REASON,
    COLLECTION_SCOPED_MAKER_TRIGGER_REASON,
    GLOBAL_MAKER_TRIGGER_REASON,
} from "./maker-triggers.js";

export const MAKER_REVALIDATION_STATUS = {
    Pending: "pending",
    Completed: "completed",
} as const;
export const MAKER_REVALIDATION_POLICY = Object.freeze({
    batchOrders: 100,
    leaseMs: 120_000,
    renewEveryMs: 30_000,
    cleanupRows: 100,
    stepBudgetMs: 5_000,
    recoveryPollMs: 5_000,
    recoveryGraceMs: 30_000,
    recoveryRows: 25,
});
export const MAKER_REVALIDATION_LOG = {
    Component: "MakerRevalidation",
    Checkpoint: "Maker revalidation checkpoint",
    Retry: "Maker revalidation step failed",
} as const;

export const MAKER_REVALIDATION_STEP_END = {
    Completed: MAKER_REVALIDATION_STATUS.Completed,
    Count: "count_budget",
    Time: "time_budget",
    Followup: "followup_generation",
} as const;

export type MakerPassBoundary = { upperOrderId: string; upperRowId: number };
export type MakerRevalidationRun = MakerPassBoundary & {
    runId: string;
    chainId: number;
    sourceJobId: string;
    payload: OrderUpdateByMakerPayload;
    status: (typeof MAKER_REVALIDATION_STATUS)[keyof typeof MAKER_REVALIDATION_STATUS];
    afterId: string;
    leaseOwner: string | null;
    leaseVersion: number;
    leaseUntil: number;
    step: number;
    resolvedOrders: number;
    failures: number;
    wakeupOutboxId: number | null;
    wakeupGeneration: number;
    scopeKey: string | null;
    generation: number;
    passGeneration: number;
    passStartedAt: number;
    requestedAt: number;
    requestedPayload: OrderUpdateByMakerPayload;
    origin?: QueueDeliveryOrigin;
};

const MAKER_VALIDATION_SCOPE = {
    WethBids: "weth-bids",
    AllSeaport: "all-seaport",
    TokenSells: "token-sells",
    CollectionSells: "collection-sells",
} as const;

/** Only hints selecting the same orders and bootstrap-gating mode can share a pass. */
export function makerValidationScopeKey(
    input: OrderUpdateByMakerPayload,
): string {
    const payload = canonicalMakerRequest(input);
    const kind =
        payload.scope === MAKER_TRIGGER_SCOPE.Global
            ? payload.reason === GLOBAL_MAKER_TRIGGER_REASON.OrderCounter
                ? MAKER_VALIDATION_SCOPE.AllSeaport
                : MAKER_VALIDATION_SCOPE.WethBids
            : payload.scope === MAKER_TRIGGER_SCOPE.Token
              ? MAKER_VALIDATION_SCOPE.TokenSells
              : MAKER_VALIDATION_SCOPE.CollectionSells;
    return JSON.stringify([
        payload.chainId,
        payload.maker,
        kind,
        payload.blockNumber == null,
        payload.scope === MAKER_TRIGGER_SCOPE.Global
            ? null
            : payload.collectionId,
        payload.scope === MAKER_TRIGGER_SCOPE.Token ? payload.tokenId : null,
    ]);
}

function makerCoverageIncludes(
    payload: OrderUpdateByMakerPayload,
    at: number,
    required: OrderUpdateByMakerPayload,
    requiredAt: number,
): boolean {
    return (
        at >= requiredAt &&
        (payload.blockNumber ?? -1) >= (required.blockNumber ?? -1) &&
        !(
            payload.blockNumber === required.blockNumber &&
            payload.blockHash &&
            required.blockHash &&
            payload.blockHash !== required.blockHash
        )
    );
}

/** Requests arriving behind a running cursor need one complete follow-up generation. */
export function advancesMakerDemand(
    run: MakerRevalidationRun,
    payload: OrderUpdateByMakerPayload,
    requiredAt: number,
): boolean {
    if (
        makerCoverageIncludes(
            run.payload,
            run.passStartedAt,
            payload,
            requiredAt,
        )
    )
        return false;
    return (
        run.generation === run.passGeneration ||
        !makerCoverageIncludes(
            run.requestedPayload,
            run.requestedAt,
            payload,
            requiredAt,
        )
    );
}

export function mergeMakerCoverage(
    run: MakerRevalidationRun,
    payload: OrderUpdateByMakerPayload,
    requiredAt: number,
): OrderUpdateByMakerPayload {
    const previous = run.requestedPayload;
    if ((payload.blockNumber ?? -1) > (previous.blockNumber ?? -1))
        return payload;
    if (
        (payload.blockNumber ?? -1) === (previous.blockNumber ?? -1) &&
        requiredAt >= run.requestedAt
    )
        return payload;
    return previous;
}
export type MakerValidationCandidate = {
    order: OrderRecord;
    revision: number;
    currentAtTrigger: boolean;
};
export type MakerValidationResolution = {
    candidate: MakerValidationCandidate;
    // Null resolves a candidate deliberately excluded by bootstrap-anchor policy.
    validation: OrderValidationResult | null;
};

export class MakerRevalidationConflict extends Error {}

export type MakerWakeup = {
    run: MakerRevalidationRun;
    outboxStatus: QueueOutboxStatus | null;
    publication?: QueuePublication;
    queueName: QueueName | null;
};

export function makerContinuationJob(
    run: MakerRevalidationRun,
    now: number,
): JobEnvelope<OrderUpdateByMakerPayload> {
    return {
        jobId: `orders:update:maker:continue:${run.runId}:${run.step}:${run.wakeupGeneration}`,
        kind: ORDER_JOB_KIND.UpdateByMaker,
        queue: makerUpdateQueue(run.payload),
        chainId: run.chainId,
        payload: {
            ...run.payload,
            continuation: { runId: run.runId, step: run.step },
        },
        attempt: 0,
        scheduledAt: now,
    };
}

/** Stable request identity ignores JSON property order and normalizes wallet casing. */
export function canonicalMakerRequest(
    payload: OrderUpdateByMakerPayload,
): OrderUpdateByMakerPayload {
    if (
        !Number.isSafeInteger(payload.chainId) ||
        payload.chainId <= 0 ||
        !/^0x[0-9a-f]{40}$/i.test(payload.maker)
    )
        throw new Error("Invalid maker request identity");
    if (
        payload.blockNumber !== undefined &&
        payload.blockNumber !== null &&
        (!Number.isSafeInteger(payload.blockNumber) || payload.blockNumber < 0)
    )
        throw new Error("Invalid maker trigger block");
    const attribution = {
        chainId: payload.chainId,
        maker: payload.maker.toLowerCase(),
        blockNumber: payload.blockNumber ?? null,
        blockHash: payload.blockHash?.toLowerCase() ?? null,
        txHash: payload.txHash?.toLowerCase() ?? null,
        logIndex: payload.logIndex ?? null,
    };
    if (
        payload.scope === MAKER_TRIGGER_SCOPE.Global &&
        Object.values(GLOBAL_MAKER_TRIGGER_REASON).some(
            (reason) => reason === payload.reason,
        )
    )
        return { ...attribution, scope: payload.scope, reason: payload.reason };
    if (
        payload.scope !== MAKER_TRIGGER_SCOPE.Global &&
        (!Number.isSafeInteger(payload.collectionId) ||
            payload.collectionId <= 0)
    )
        throw new Error("Invalid maker collection scope");
    if (
        payload.scope === MAKER_TRIGGER_SCOPE.Token &&
        /^\d+$/.test(payload.tokenId) &&
        Object.values(TOKEN_SCOPED_MAKER_TRIGGER_REASON).some(
            (reason) => reason === payload.reason,
        )
    )
        return {
            ...attribution,
            scope: payload.scope,
            collectionId: payload.collectionId,
            tokenId: payload.tokenId,
            contract: payload.contract?.toLowerCase(),
            reason: payload.reason,
        };
    if (
        payload.scope === MAKER_TRIGGER_SCOPE.Collection &&
        Object.values(COLLECTION_SCOPED_MAKER_TRIGGER_REASON).some(
            (reason) => reason === payload.reason,
        )
    )
        return {
            ...attribution,
            scope: payload.scope,
            collectionId: payload.collectionId,
            contract: payload.contract?.toLowerCase(),
            reason: payload.reason,
        };
    throw new Error("Unsupported maker request scope or reason");
}
