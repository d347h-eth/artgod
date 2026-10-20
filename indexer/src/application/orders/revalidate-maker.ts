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
import type {
    OrderMakerContinuationPayload,
    OrderUpdateByMakerPayload,
} from "../../domain/order-jobs.js";
import type { QueueName } from "../../domain/queues.js";
import type { MakerRevalidationStore } from "../../ports/maker-revalidation.js";
import type { QueueDeliveryOrigin } from "../../ports/queue.js";
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
            now?: () => number;
            observability?: OrderProcessingObservability;
        },
    ) {}

    async execute(input: {
        jobId: string;
        payload: OrderUpdateByMakerPayload;
        origin: QueueDeliveryOrigin;
        observationKey?: string;
        /** Raw historical hints retain/coalesce intent and publish main validation. */
        admissionOnly?: boolean;
    }): Promise<void> {
        if (!input.jobId)
            throw new UnsupportedJob("Maker request job identity is required");
        let payload: OrderUpdateByMakerPayload;
        try {
            payload = canonicalMakerRequest(input.payload);
        } catch (error) {
            throw new UnsupportedJob(String(error));
        }
        const admitted = await this.retain(
            input.jobId,
            payload.chainId,
            false,
            () => this.deps.store.admit({ ...input, payload, now: this.now() }),
        );
        if (!admitted || admitted.status === STATUS.Completed) return;
        if (input.admissionOnly) {
            this.deps.store.scheduleWakeup(admitted, this.now());
            return;
        }
        // A redelivered origin can ACK once the atomic checkpoint/outbox owns the rest.
        if (
            admitted.wakeupOutboxId !== null ||
            admitted.sourceJobId !== input.jobId
        )
            return;
        this.expand(admitted);
    }

    async resume(input: {
        jobId: string;
        payload: OrderMakerContinuationPayload;
        queueName: QueueName;
        origin: QueueDeliveryOrigin;
    }): Promise<void> {
        const { payload } = input;
        if (
            !input.jobId ||
            !Number.isSafeInteger(payload.chainId) ||
            payload.chainId <= 0 ||
            typeof payload.runId !== "string" ||
            !payload.runId ||
            !Number.isSafeInteger(payload.step) ||
            payload.step < 0
        )
            throw new UnsupportedJob("Invalid maker continuation");
        const admitted = await this.retain(
            input.jobId,
            payload.chainId,
            true,
            () =>
                this.deps.store.resume({
                    ...payload,
                    queueName: input.queueName,
                    origin: input.origin,
                }),
        );
        if (admitted && admitted.status !== STATUS.Completed)
            this.expand(admitted);
    }

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }

    private async retain(
        jobId: string,
        chainId: number,
        continuation: boolean,
        retain: () => MakerRevalidationRun | null,
    ): Promise<MakerRevalidationRun | null> {
        try {
            return await observeProcessing(
                this.deps.observability,
                OPERATION.MakerAdmit,
                { chainId, continuation },
                async () => retain(),
            );
        } catch (error) {
            if (error instanceof MakerRevalidationConflict)
                throw new UnsupportedJob(error.message);
            // Until admission commits, the broker message is the only durable owner.
            logger.warn(LOG.AdmissionRetry, {
                component: LOG.Component,
                jobId,
                chainId,
                error: String(error),
            });
            throw new JobDeferred(
                "Maker request persistence unavailable",
                POLICY.admissionRetryMs,
            );
        }
    }

    private expand(admitted: MakerRevalidationRun): void {
        const { store, observability: hooks } = this.deps;
        const now = () => this.now();
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
            // The failed page retained no cursor movement. After this durable release,
            // periodic maker recovery owns retry; the input delivery can ACK.
        } finally {
            store.release(run, now());
        }
    }
}
