import { randomUUID } from "node:crypto";
import { logger } from "@artgod/shared/utils";
import {
    ORDER_VALIDATION_DEMAND_POLICY as POLICY,
    ORDER_VALIDATION_DEMAND_LOG as LOG,
    validationProofSatisfies,
    type OrderValidationRequest,
    type OrderValidationCompletion,
} from "../../domain/order-validation-demand.js";
import type { OrderValidationDemandPort } from "../../ports/order-validation-demand.js";
import type {
    OrderValidationSnapshotFactory,
    MakerValidationBatch,
} from "../../ports/order-validation.js";
import type { OrderValidationAdmissionPort } from "../../ports/order-validation-admission.js";
import { ORDER_PROCESSING_POLICY } from "../../domain/order-processing.js";
import {
    observeBestEffort,
    observeProcessing,
    observeSyncProcessing,
} from "../processing-observability.js";
import {
    ORDER_PROCESSING_OPERATION as OPERATION,
    type OrderProcessingObservability,
} from "./observability.js";

export class AdmitOrderValidation {
    constructor(
        private readonly chainId: number,
        private readonly store: OrderValidationDemandPort,
        private readonly observability?: OrderProcessingObservability,
    ) {}
    execute(request: OrderValidationRequest) {
        if (request.chainId !== this.chainId)
            throw new Error("Order validation demand chain mismatch");
        return observeSyncProcessing(
            this.observability,
            OPERATION.DemandAdmit,
            { chainId: this.chainId },
            () => this.store.admit(request, Date.now()),
        );
    }
}

export type OrderValidationBatchReport = {
    scanned: number;
    claimed: number;
    validated: number;
    applied: number;
    covered: number;
    resolvedUnneeded: number;
    followup: number;
    retried: number;
    released: number;
    lostClaims: number;
    oldestRequiredAt: number | null;
    durationMs: number;
    contractReads: ReturnType<MakerValidationBatch["readCounts"]> | null;
};

/** Runtime reporting remains bounded and separate from validation persistence. */
export interface OrderValidationDemandReporter {
    record(report: OrderValidationBatchReport | undefined): void;
    flush(): void;
}

/** Polling persisted demand is also restart recovery; no publish/ACK gap owns liveness. */
export class ValidateOrderDemand {
    constructor(
        private readonly deps: {
            chainId: number;
            store: OrderValidationDemandPort;
            createSnapshot: OrderValidationSnapshotFactory;
            admission: OrderValidationAdmissionPort;
            now?: () => number;
            observability?: OrderProcessingObservability;
        },
    ) {}

    async executeBatch(
        signal?: AbortSignal,
    ): Promise<OrderValidationBatchReport | undefined> {
        // Acquire fair capacity before claiming rows or aging a chain snapshot.
        if (signal?.aborted) return undefined;
        return this.deps.admission.run(async () => {
            if (signal?.aborted) return undefined;
            const report = await this.validateBatch(
                () => signal?.aborted ?? false,
            );
            if (report)
                observeBestEffort(() =>
                    this.deps.observability?.observer?.demandBatch(
                        report,
                        (this.deps.now ?? Date.now)(),
                    ),
                );
            return report;
        }, signal);
    }

    private async validateBatch(
        shouldStop: () => boolean,
    ): Promise<OrderValidationBatchReport | undefined> {
        const now = this.deps.now ?? Date.now;
        const startedAt = now();
        const hooks = this.deps.observability;
        const attributes = { chainId: this.deps.chainId };
        const batch = observeSyncProcessing(
            hooks,
            OPERATION.DemandClaim,
            attributes,
            () =>
                this.deps.store.claimBatch(
                    this.deps.chainId,
                    randomUUID(),
                    now(),
                ),
        );
        if (!batch.scanned) return undefined;
        const report: OrderValidationBatchReport = {
            scanned: batch.scanned,
            claimed: batch.claims.length,
            validated: 0,
            applied: 0,
            covered: 0,
            resolvedUnneeded: batch.resolvedUnneeded,
            followup: 0,
            retried: 0,
            released: 0,
            lostClaims: 0,
            oldestRequiredAt: batch.oldestRequiredAt,
            durationMs: 0,
            contractReads: null,
        };
        if (!batch.claims.length) {
            report.durationMs = now() - startedAt;
            return report;
        }
        const timer = setInterval(() => {
            try {
                for (const claim of batch.claims)
                    this.deps.store.renew(claim, now());
            } catch {
                /* The commit fence remains authoritative. */
            }
        }, POLICY.renewEveryMs);
        timer.unref?.();
        let snapshot:
            | Awaited<ReturnType<OrderValidationSnapshotFactory>>
            | undefined;
        try {
            await observeProcessing(
                hooks,
                OPERATION.DemandBatch,
                { ...attributes, claimed: batch.claims.length },
                async () => {
                    snapshot = await observeProcessing(
                        hooks,
                        OPERATION.DemandSnapshot,
                        attributes,
                        () =>
                            this.deps.createSnapshot({
                                chainId: this.deps.chainId,
                                // Different demands have different trigger blocks. Check each against the
                                // fresh snapshot below so one future trigger cannot block unrelated work.
                                minimumBlock: null,
                                candidates: batch.claims.map(
                                    (claim) => claim.candidate.order,
                                ),
                            }),
                    );
                    const ready = batch.claims.filter((claim) =>
                        validationProofSatisfies(snapshot!.proof, claim.demand),
                    );
                    const uncovered = batch.claims.filter(
                        (claim) =>
                            !validationProofSatisfies(
                                snapshot!.proof,
                                claim.demand,
                            ),
                    );
                    report.retried += this.deps.store.fail(
                        uncovered,
                        new Error(
                            "Snapshot does not yet cover demand observation or trigger block",
                        ),
                        now(),
                    );
                    const completions: OrderValidationCompletion[] = [];
                    await observeProcessing(
                        hooks,
                        OPERATION.DemandValidate,
                        attributes,
                        async () => {
                            for (const claim of ready) {
                                if (
                                    shouldStop() ||
                                    (completions.length > 0 &&
                                        !snapshot!.canAccept())
                                )
                                    break;
                                const result = await snapshot!.validate(
                                    claim.candidate.order,
                                );
                                report.validated++;
                                completions.push({ claim, result });
                            }
                        },
                    );
                    await observeProcessing(
                        hooks,
                        OPERATION.DemandVerify,
                        attributes,
                        () => snapshot!.finish(),
                    );
                    const completed = observeSyncProcessing(
                        hooks,
                        OPERATION.DemandCommit,
                        attributes,
                        () =>
                            this.deps.store.completeBatch(
                                completions,
                                snapshot!.proof,
                                now(),
                            ),
                    );
                    report.applied = completed.applied;
                    report.covered = completed.covered;
                    report.followup = completed.followup;
                    report.lostClaims = completed.lostClaims;
                    report.resolvedUnneeded += completed.resolvedUnneeded;
                    report.released = this.deps.store.release(
                        ready.slice(completions.length),
                        now(),
                    );
                },
            );
        } catch (error) {
            report.retried += this.deps.store.fail(batch.claims, error, now());
            logger.warn(LOG.BatchFailed, {
                component: LOG.Component,
                chainId: this.deps.chainId,
                claimed: report.claimed,
                error: String(error),
            });
        } finally {
            clearInterval(timer);
            report.contractReads = snapshot?.readCounts() ?? null;
            report.durationMs = now() - startedAt;
        }
        return report;
    }
}

export function startOrderValidationDemand(
    processor: Pick<ValidateOrderDemand, "executeBatch">,
    reporter?: OrderValidationDemandReporter,
): () => Promise<void> {
    const controller = new AbortController();
    const waits = new Set<() => void>();
    const pause = (busy: boolean) =>
        new Promise<void>((resolve) => {
            const resume = () => {
                clearTimeout(timer);
                waits.delete(resume);
                resolve();
            };
            // Yield to broker/lifecycle work after a batch; poll only when idle or failed.
            const timer = setTimeout(resume, busy ? 0 : POLICY.pollMs);
            timer.unref?.();
            waits.add(resume);
            if (controller.signal.aborted) resume();
        });
    const run = async () => {
        while (!controller.signal.aborted) {
            let busy = false;
            try {
                const report = await processor.executeBatch(controller.signal);
                busy = !!report;
                reporter?.record(report);
            } catch (error) {
                if (!controller.signal.aborted)
                    logger.warn(LOG.PollFailed, {
                        component: LOG.Component,
                        error: String(error),
                    });
            }
            if (!controller.signal.aborted) await pause(busy);
        }
    };
    // Demand can use both existing permits when other paths are idle. It queues
    // at most these two executors and rejoins FIFO admission after every batch.
    const active = Array.from(
        { length: ORDER_PROCESSING_POLICY.concurrentValidations },
        run,
    );
    return async () => {
        controller.abort();
        for (const resume of waits) resume();
        await Promise.all(active);
        reporter?.flush();
    };
}
