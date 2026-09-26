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
    type MakerValidationCheckpointEntry,
} from "../../domain/maker-revalidation.js";
import { OrderValidationReadUnavailable } from "../../domain/order-validation-failure.js";
import type { OrderUpdateByMakerPayload } from "../../domain/order-jobs.js";
import type { MakerRevalidationStore } from "../../ports/maker-revalidation.js";
import type { OrderValidationSnapshotFactory } from "../../ports/order-validation.js";
import type { OrderValidationAdmissionPort } from "../../ports/order-validation-admission.js";
import type {
    QueueDeliveryOrigin,
    QueueReplayBoundary,
} from "../../ports/queue.js";

export class RevalidateMakerOrders {
    constructor(
        private readonly deps: {
            store: MakerRevalidationStore;
            createSnapshot: OrderValidationSnapshotFactory;
            admission: OrderValidationAdmissionPort;
            replayBoundary?: (
                consumerName: string,
            ) => Promise<QueueReplayBoundary>;
            now?: () => number;
        },
    ) {}

    async execute(input: {
        jobId: string;
        payload: OrderUpdateByMakerPayload;
        origin?: QueueDeliveryOrigin;
        requiredAt?: number;
    }): Promise<void> {
        const { store } = this.deps;
        const now = this.deps.now ?? Date.now;
        if (!input.jobId)
            throw new UnsupportedJob("Maker request job identity is required");
        if (
            input.requiredAt !== undefined &&
            (!Number.isSafeInteger(input.requiredAt) || input.requiredAt < 0)
        )
            throw new UnsupportedJob("Invalid maker demand time");
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
            if (input.origin && this.deps.replayBoundary)
                store.cleanup(
                    await this.deps.replayBoundary(input.origin.consumerName),
                    POLICY.cleanupRows,
                );
            admitted = continuation
                ? store.resume({
                      chainId: payload.chainId,
                      ...continuation,
                      origin: input.origin,
                  })
                : store.admit({ ...input, payload, now: now() });
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
        // A redelivered origin can ACK once the atomic checkpoint/outbox owns the rest.
        if (
            !continuation &&
            (admitted.wakeupOutboxId !== null ||
                admitted.sourceJobId !== input.jobId)
        )
            return;
        let run = store.claim(admitted.runId, randomUUID(), now());
        if (!run)
            throw new JobDeferred(
                "Maker request is already owned",
                POLICY.renewEveryMs,
            );
        let lostLease = false;
        const timer = setInterval(() => {
            try {
                if (!store.renew(run!, now())) lostLease = true;
            } catch {
                lostLease = true;
            }
        }, POLICY.renewEveryMs);
        timer.unref?.();
        try {
            if (lostLease)
                throw new MakerRevalidationConflict(
                    "Maker execution lost its lease",
                );
            const claimed = run;
            run = await this.deps.admission.run(() => this.step(claimed, now));
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
            clearInterval(timer);
            store.release(run, now());
        }
    }

    private async step(
        run: MakerRevalidationRun,
        now: () => number,
    ): Promise<MakerRevalidationRun> {
        const start = now();
        const page = this.deps.store.next(run, POLICY.batchOrders);
        const isolatedIndex = page.findIndex(
            (candidate) => candidate.order.id === run.isolateOrderId,
        );
        // Commit the healthy prefix with a new snapshot before retrying the failing
        // candidate alone. The persisted target survives this prefix checkpoint.
        const candidates =
            isolatedIndex < 0
                ? page
                : page.slice(0, Math.max(1, isolatedIndex));
        const resolutions: MakerValidationCheckpointEntry[] = [];
        let stepEnd: (typeof STEP_END)[keyof typeof STEP_END] = STEP_END.Count;
        const first = candidates.find(
            (candidate) => candidate.currentAtTrigger,
        );
        const batch = first
            ? await this.deps.createSnapshot({
                  chainId: run.chainId,
                  minimumBlock: run.payload.blockNumber ?? null,
                  candidates: candidates
                      .filter((candidate) => candidate.currentAtTrigger)
                      .map((candidate) => candidate.order),
              })
            : undefined;
        for (const candidate of candidates) {
            if (resolutions.length && now() - start >= POLICY.stepBudgetMs) {
                stepEnd = STEP_END.Time;
                break;
            }
            if (candidate.currentAtTrigger) {
                if (resolutions.length && !batch!.canAccept()) {
                    stepEnd = STEP_END.Time;
                    break;
                }
                try {
                    const validation = await batch!.validate(candidate.order);
                    resolutions.push({ candidate, validation });
                } catch (error) {
                    if (
                        isolatedIndex !== 0 ||
                        !(error instanceof OrderValidationReadUnavailable) ||
                        error.orderId !== candidate.order.id
                    )
                        throw error;
                    resolutions.push({
                        candidate,
                        deferredError: String(error),
                    });
                }
            } else resolutions.push({ candidate, validation: null });
        }
        // An isolated failed snapshot has no result to commit. Its durable handoff
        // carries the unmet requirement, never a validation proof from that snapshot.
        if (batch && !resolutions.some((result) => "deferredError" in result))
            await batch.finish();
        const complete =
            resolutions.length === page.length &&
            page.length < POLICY.batchOrders;
        const next = this.deps.store.checkpoint(
            run,
            resolutions,
            complete,
            now(),
        );
        logger.info(LOG.Checkpoint, {
            component: LOG.Component,
            runId: next.runId,
            sourceJobId: next.sourceJobId,
            chainId: next.chainId,
            step: next.step,
            afterId: next.afterId,
            candidates: candidates.length,
            resolved: next.resolvedOrders - run.resolvedOrders,
            deferred: next.deferredOrders - run.deferredOrders,
            totalResolved: next.resolvedOrders,
            totalDeferred: next.deferredOrders,
            durationMs: now() - start,
            status: next.status,
            eligible: candidates.filter(
                (candidate) => candidate.currentAtTrigger,
            ).length,
            validated: resolutions.filter(
                (resolution) =>
                    "validation" in resolution &&
                    resolution.validation !== null,
            ).length,
            contractReads: batch?.readCounts() ?? null,
            stepEnd: complete
                ? next.status === STATUS.Completed
                    ? STEP_END.Completed
                    : STEP_END.Followup
                : stepEnd,
            generation: next.generation,
            passGeneration: next.passGeneration,
            priorFailures: run.failures,
            wakeupGeneration: next.wakeupGeneration,
        });
        return next;
    }
}
