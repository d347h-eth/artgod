import { randomUUID } from "node:crypto";
import { logger } from "@artgod/shared/utils";
import { JobDeferred } from "../../domain/job-deferred.js";
import {
    MAKER_REVALIDATION_LOG as LOG,
    MAKER_REVALIDATION_POLICY as POLICY,
    MAKER_REVALIDATION_STATUS as STATUS,
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
        const admitted = store.admit({
            ...input,
            payload: canonicalMakerRequest(input.payload),
            now: now(),
        });
        if (admitted.status === STATUS.Completed) return;
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
            // P2 deliberately retains one delivery across the pass. P3 replaces this
            // loop with a durable continuation once checkpoint behavior is proven.
            while (run.status !== STATUS.Completed) {
                if (lostLease)
                    throw new MakerRevalidationConflict(
                        "Maker execution lost its lease",
                    );
                run = await this.step(run, now);
            }
        } catch (error) {
            store.release(run, now(), error);
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
            if (candidate.currentAtTrigger) {
                const isWethBid =
                    candidate.order.side === "buy" &&
                    candidate.order.currency?.toLowerCase() ===
                        this.deps.wethAddress.toLowerCase();
                if (
                    resolutions.length &&
                    (!!batch !== isWethBid || (batch && !batch.canAccept()))
                )
                    break;
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
        });
        return next;
    }
}
