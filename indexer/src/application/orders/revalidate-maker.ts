import { randomUUID } from "node:crypto";
import { logger } from "@artgod/shared/utils";
import { JobDeferred } from "../../domain/job-deferred.js";
import {
    MAKER_REVALIDATION_LOG as LOG,
    MAKER_REVALIDATION_POLICY as POLICY,
    MAKER_REVALIDATION_STATUS as STATUS,
    MAKER_REVALIDATION_STEP_END as STEP_END,
    MakerRevalidationConflict,
    canonicalMakerRequest,
    type MakerRevalidationRun,
    type MakerValidationResolution,
} from "../../domain/maker-revalidation.js";
import type { OrderUpdateByMakerPayload } from "../../domain/order-jobs.js";
import type { MakerRevalidationStore } from "../../ports/maker-revalidation.js";
import type {
    MakerValidationBatchFactory,
    OrderValidator,
} from "../../ports/order-validation.js";
import type {
    QueueDeliveryOrigin,
    QueueReplayBoundary,
} from "../../ports/queue.js";

export class RevalidateMakerOrders {
    constructor(
        private readonly deps: {
            store: MakerRevalidationStore;
            validateOrder: OrderValidator;
            createValidationBatch: MakerValidationBatchFactory;
            wethAddress: string;
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
    }): Promise<void> {
        const { store } = this.deps;
        const now = this.deps.now ?? Date.now;
        if (input.origin && this.deps.replayBoundary)
            store.cleanup(
                await this.deps.replayBoundary(input.origin.consumerName),
                POLICY.cleanupRows,
            );
        if (!input.jobId)
            throw new Error("Maker request job identity is required");
        const payload = canonicalMakerRequest(input.payload);
        const continuation = input.payload.continuation;
        if (
            continuation &&
            (!continuation.runId ||
                !Number.isSafeInteger(continuation.step) ||
                continuation.step < 0)
        )
            throw new Error("Invalid maker continuation");
        const admitted = continuation
            ? store.resume({
                  chainId: payload.chainId,
                  ...continuation,
                  origin: input.origin,
              })
            : store.admit({ ...input, payload, now: now() });
        if (!admitted) return;
        if (JSON.stringify(admitted.payload) !== JSON.stringify(payload))
            throw new MakerRevalidationConflict(
                "Maker continuation payload changed",
            );
        if (admitted.status === STATUS.Completed) return;
        // A redelivered origin can ACK once the atomic checkpoint/outbox owns the rest.
        if (!continuation && admitted.wakeupOutboxId !== null) return;
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
            run = await this.step(run, now);
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
        const candidates = this.deps.store.next(run, POLICY.batchOrders);
        const resolutions: MakerValidationResolution[] = [];
        let stepEnd: (typeof STEP_END)[keyof typeof STEP_END] = STEP_END.Count;
        const first = candidates.find(
            (candidate) => candidate.currentAtTrigger,
        );
        const useBatch =
            first?.order.side === "buy" &&
            first.order.currency?.toLowerCase() ===
                this.deps.wethAddress.toLowerCase();
        const batch = useBatch
            ? await this.deps.createValidationBatch({
                  chainId: run.chainId,
                  minimumBlock: run.payload.blockNumber ?? null,
              })
            : undefined;
        for (const candidate of candidates) {
            if (resolutions.length && now() - start >= POLICY.stepBudgetMs) {
                stepEnd = STEP_END.Time;
                break;
            }
            if (candidate.currentAtTrigger) {
                const isWethBid =
                    candidate.order.side === "buy" &&
                    candidate.order.currency?.toLowerCase() ===
                        this.deps.wethAddress.toLowerCase();
                if (
                    resolutions.length &&
                    (!!batch !== isWethBid || (batch && !batch.canAccept()))
                ) {
                    stepEnd =
                        !!batch !== isWethBid ? STEP_END.Scope : STEP_END.Time;
                    break;
                }
                const validation = await (batch
                    ? batch.validate(candidate.order)
                    : this.deps.validateOrder(candidate.order));
                resolutions.push({ candidate, validation });
            } else resolutions.push({ candidate, validation: null });
        }
        if (batch) await batch.finish();
        const complete =
            resolutions.length === candidates.length &&
            candidates.length < POLICY.batchOrders;
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
            resolved: resolutions.length,
            totalResolved: next.resolvedOrders,
            durationMs: now() - start,
            status: next.status,
            eligible: candidates.filter(
                (candidate) => candidate.currentAtTrigger,
            ).length,
            validated: resolutions.filter(
                (resolution) => resolution.validation !== null,
            ).length,
            contractReads: batch?.readCounts() ?? null,
            stepEnd: complete ? STEP_END.Completed : stepEnd,
            priorFailures: run.failures,
            wakeupGeneration: next.wakeupGeneration,
        });
        return next;
    }
}
