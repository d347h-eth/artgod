import { randomUUID } from "node:crypto";
import { logger } from "@artgod/shared/utils";
import { JobDeferred } from "../../domain/job-deferred.js";
import { UnsupportedJob } from "../../domain/unsupported-job.js";
import {
    MAKER_REVALIDATION_LOG as LOG,
    MAKER_REVALIDATION_POLICY as POLICY,
    MAKER_REVALIDATION_STATUS as STATUS,
    MAKER_REVALIDATION_STEP_END as STEP_END,
    MakerRevalidationConflict,
    canonicalMakerRequest,
    type MakerRevalidationRun,
} from "../../domain/maker-revalidation.js";
import type { OrderUpdateByMakerPayload } from "../../domain/order-jobs.js";
import type { MakerRevalidationStore } from "../../ports/maker-revalidation.js";
import type {
    QueueDeliveryOrigin,
    QueueReplayBoundary,
} from "../../ports/queue.js";
import {
    observeBestEffort,
    observeProcessing,
    observeSyncProcessing,
} from "../processing-observability.js";
import {
    ORDER_PROCESSING_OPERATION as OPERATION,
    type OrderProcessingObservability,
} from "./observability.js";

export class RevalidateMakerOrders {
    constructor(
        private readonly deps: {
            store: MakerRevalidationStore;
            replayBoundary?: (
                consumerName: string,
            ) => Promise<QueueReplayBoundary>;
            now?: () => number;
            observability?: OrderProcessingObservability;
        },
    ) {}

    async execute(input: {
        jobId: string;
        payload: OrderUpdateByMakerPayload;
        origin?: QueueDeliveryOrigin;
        observationKey?: string;
        /** Raw historical hints retain/coalesce intent and publish main validation. */
        admissionOnly?: boolean;
    }): Promise<void> {
        const { store } = this.deps;
        const now = this.deps.now ?? Date.now;
        const hooks = this.deps.observability;
        if (!input.jobId)
            throw new UnsupportedJob("Maker request job identity is required");
        let payload: OrderUpdateByMakerPayload;
        try {
            payload = canonicalMakerRequest(input.payload);
        } catch (error) {
            throw new UnsupportedJob(String(error));
        }
        const continuation = input.payload.continuation;
        if (
            continuation &&
            (!continuation.runId ||
                !Number.isSafeInteger(continuation.step) ||
                continuation.step < 0)
        )
            throw new UnsupportedJob("Invalid maker continuation");
        let admitted: MakerRevalidationRun | null;
        try {
            admitted = await observeProcessing(
                hooks,
                OPERATION.MakerAdmit,
                { chainId: payload.chainId, continuation: !!continuation },
                async () => {
                    if (input.origin && this.deps.replayBoundary) {
                        const boundary = await this.deps.replayBoundary(
                            input.origin.consumerName,
                        );
                        const cleaned = observeSyncProcessing(
                            hooks,
                            OPERATION.MakerCleanup,
                            { chainId: payload.chainId },
                            () => store.cleanup(boundary, POLICY.cleanupRows),
                        );
                        observeBestEffort(() =>
                            hooks?.observer?.makerReceiptsCleaned(cleaned),
                        );
                    }
                    return continuation
                        ? store.resume({
                              chainId: payload.chainId,
                              ...continuation,
                              origin: input.origin,
                          })
                        : store.admit({ ...input, payload, now: now() });
                },
            );
        } catch (error) {
            if (error instanceof MakerRevalidationConflict)
                throw new UnsupportedJob(error.message);
            // Until admission commits, the broker message is the only durable owner.
            // Sending it to the log-only DLQ would leave nothing for run recovery.
            logger.warn(LOG.AdmissionRetry, {
                component: LOG.Component,
                jobId: input.jobId,
                chainId: payload.chainId,
                error: String(error),
            });
            throw new JobDeferred(
                "Maker request persistence unavailable",
                POLICY.admissionRetryMs,
            );
        }
        if (!admitted) return;
        if (
            continuation &&
            JSON.stringify(admitted.payload) !== JSON.stringify(payload)
        )
            throw new MakerRevalidationConflict(
                "Maker continuation payload changed",
            );
        if (admitted.status === STATUS.Completed) return;
        if (input.admissionOnly && !continuation) {
            store.scheduleWakeup(admitted, now());
            return;
        }
        // A redelivered origin can ACK once the atomic checkpoint/outbox owns the rest.
        if (
            !continuation &&
            (admitted.wakeupOutboxId !== null ||
                admitted.sourceJobId !== input.jobId)
        )
            return;
        // Expanding a finite local page does not acquire RPC capacity or await sync.
        // Unready orders are owned by ordinary demand before this delivery ACKs.
        const run = store.claim(admitted.runId, randomUUID(), now());
        if (!run) return; // Existing durable owner/recovery retains the obligation.
        try {
            const start = now();
            const next = observeSyncProcessing(
                hooks,
                OPERATION.MakerCheckpoint,
                { chainId: run.chainId, runId: run.runId, step: run.step },
                () => store.expand(run, now()),
            );
            const progress = {
                resolved: next.resolvedOrders - run.resolvedOrders,
                deferred: next.deferredOrders - run.deferredOrders,
                validated: 0,
                stepEnd:
                    next.status === STATUS.Completed
                        ? STEP_END.Completed
                        : next.passGeneration !== run.passGeneration
                          ? STEP_END.Followup
                          : STEP_END.Count,
            };
            observeBestEffort(() => hooks?.observer?.makerCheckpoint(progress));
            logger.info(LOG.Checkpoint, {
                component: LOG.Component,
                runId: next.runId,
                sourceJobId: next.sourceJobId,
                chainId: next.chainId,
                step: next.step,
                afterId: next.afterId,
                ...progress,
                totalResolved: next.resolvedOrders,
                totalDeferred: next.deferredOrders,
                durationMs: now() - start,
                status: next.status,
                generation: next.generation,
                passGeneration: next.passGeneration,
                priorFailures: run.failures,
                wakeupGeneration: next.wakeupGeneration,
            });
        } catch (error) {
            store.release(run, now(), error);
            logger.warn(LOG.Retry, {
                component: LOG.Component,
                runId: run.runId,
                step: run.step,
                priorFailures: run.failures,
                error: String(error),
            });
            throw error;
        } finally {
            store.release(run, now());
        }
    }
}
