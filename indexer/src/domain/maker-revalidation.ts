import type {
    OrderMakerContinuationPayload,
    OrderUpdateByMakerPayload,
} from "./order-jobs.js";
import {
    SYNC_WORK_CLASS,
    decodeSyncWorkClass,
    strongestSyncWorkClass,
    type SyncWorkClass,
} from "@artgod/shared/types/sync-work-class";
import type { OrderRecord } from "./orders.js";
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

import { MAKER_REVALIDATION_STATUS } from "@artgod/shared/market-data/order-validation";
export { MAKER_REVALIDATION_STATUS } from "@artgod/shared/market-data/order-validation";

export const MAKER_REVALIDATION_POLICY = Object.freeze({
    batchOrders: 100,
    leaseMs: 120_000,
    admissionRetryMs: 1_000,
    cleanupRows: 100,
    recoveryPollMs: 5_000,
    recoveryGraceMs: 30_000,
    recoveryRows: 25,
});
export const MAKER_REVALIDATION_LOG = {
    Component: "MakerRevalidation",
    Checkpoint: "Maker revalidation checkpoint",
    Retry: "Maker revalidation step failed",
    AdmissionRetry: "Maker revalidation admission failed; trigger retained",
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
    /** Cumulative handoffs, not the current number of unfinished demands. */
    deferredOrders: number;
    failures: number;
    wakeupOutboxId: number | null;
    wakeupGeneration: number;
    scopeKey: string;
    generation: number;
    passGeneration: number;
    passStartedAt: number;
    chainRevision: number;
    /** One locally retained source admission is shared by the finite expansion. */
    admissionSequence: number;
    requestedAdmissionSequence: number;
    observationKey: string | null;
    requestedObservationKey: string | null;
    requestedAt: number;
    requestedPayload: OrderUpdateByMakerPayload;
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
    chainRevision: number,
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
        chainRevision,
        payload.maker,
        kind,
        payload.blockNumber == null,
        payload.scope === MAKER_TRIGGER_SCOPE.Global
            ? null
            : payload.collectionId,
        payload.scope === MAKER_TRIGGER_SCOPE.Token ? payload.tokenId : null,
    ]);
}

/** Canonical requirements are ordered by accepted height, never delivery time.
 * Source owners supply stable observation identities after duplicate classification. */
export function advancesMakerDemand(
    run: MakerRevalidationRun,
    payload: OrderUpdateByMakerPayload,
    observationKey: string | null,
): boolean {
    if (payload.blockNumber == null)
        return observationKey !== run.requestedObservationKey;
    const previous = run.requestedPayload;
    return (
        previous.blockNumber == null ||
        payload.blockNumber > previous.blockNumber ||
        (payload.blockNumber === previous.blockNumber &&
            payload.blockHash !== previous.blockHash)
    );
}

export function mergeMakerRequirements(
    run: MakerRevalidationRun,
    payload: OrderUpdateByMakerPayload,
): OrderUpdateByMakerPayload {
    const previous = run.requestedPayload;
    const selected =
        (payload.blockNumber ?? -1) >= (previous.blockNumber ?? -1)
            ? payload
            : previous;
    return canonicalMakerRequest(
        previous.workClass === undefined && payload.workClass === undefined
            ? selected
            : {
                  ...selected,
                  workClass: strongestSyncWorkClass(
                      decodeSyncWorkClass(previous.workClass),
                      decodeSyncWorkClass(payload.workClass),
                  ),
              },
    );
}

export function makerWorkClass(run: MakerRevalidationRun) {
    return strongestSyncWorkClass(
        decodeSyncWorkClass(run.payload.workClass),
        decodeSyncWorkClass(run.requestedPayload.workClass),
    );
}
export type MakerValidationCandidate = {
    order: OrderRecord;
    revision: number;
    currentAtTrigger: boolean;
};

export class MakerRevalidationConflict extends Error {}

export type MakerWakeup = {
    run: MakerRevalidationRun;
    outboxStatus: QueueOutboxStatus | null;
    publication?: QueuePublication;
    queueName: QueueName | null;
    /** Class of the persisted continuation, even if its run was subsequently promoted. */
    workClass?: SyncWorkClass;
};

export function makerContinuationJob(
    run: MakerRevalidationRun,
    now: number,
): JobEnvelope<OrderMakerContinuationPayload> {
    return {
        jobId: `orders:update:maker:continue:${run.runId}:${run.step}:${run.wakeupGeneration}`,
        kind: ORDER_JOB_KIND.ContinueMaker,
        queue: makerUpdateQueue(run.payload),
        chainId: run.chainId,
        workClass: makerWorkClass(run),
        payload: {
            chainId: run.chainId,
            runId: run.runId,
            step: run.step,
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
    if (
        (payload.blockNumber == null) !== (payload.blockHash == null) ||
        (payload.blockHash != null &&
            !/^0x[0-9a-f]{64}$/i.test(payload.blockHash))
    )
        throw new Error(
            "Maker canonical trigger requires block number and hash",
        );
    // Work admitted to this domain is current-order validation. The envelope
    // can still classify a raw historical hint as background admission work.
    decodeSyncWorkClass(payload.workClass);
    const attribution = {
        ...(payload.workClass === undefined
            ? {}
            : { workClass: SYNC_WORK_CLASS.Main }),
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
