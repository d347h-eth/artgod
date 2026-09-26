import { logger } from "@artgod/shared/utils";
import { ORDER_VALIDATION_DEMAND_LOG as LOG } from "../../domain/order-validation-demand.js";
import type {
    OrderValidationBatchReport,
    OrderValidationDemandReporter,
} from "../../application/orders/validate-order-demand.js";
import { ORDER_VALIDATION_BATCH_COUNTERS as counters } from "../../application/orders/observability.js";

export const ORDER_VALIDATION_REPORTING_POLICY = Object.freeze({
    intervalMs: 10_000,
});

const emptyCounts = () => ({
    scanned: 0,
    claimed: 0,
    validated: 0,
    applied: 0,
    covered: 0,
    resolvedUnneeded: 0,
    followup: 0,
    retried: 0,
    released: 0,
    lostClaims: 0,
});

/** One bounded aggregate per chain worker/window; no order/maker identifiers or arrays. */
export class OrderValidationDemandProgress implements OrderValidationDemandReporter {
    private startedAt: number;
    private batches = 0;
    private counts = emptyCounts();
    private batchDurationMs = 0;
    private maximumBatchDurationMs = 0;
    private oldestRequiredAt: number | null = null;
    private reads = { perOrder: 0, shared: 0, other: 0, statusBatches: 0 };

    constructor(
        private readonly chainId: number,
        private readonly now: () => number = Date.now,
    ) {
        this.startedAt = now();
    }

    record(report: OrderValidationBatchReport | undefined): void {
        if (report) {
            this.batches++;
            for (const key of counters) this.counts[key] += report[key];
            this.batchDurationMs += report.durationMs;
            this.maximumBatchDurationMs = Math.max(
                this.maximumBatchDurationMs,
                report.durationMs,
            );
            if (report.oldestRequiredAt !== null)
                this.oldestRequiredAt =
                    this.oldestRequiredAt === null
                        ? report.oldestRequiredAt
                        : Math.min(
                              this.oldestRequiredAt,
                              report.oldestRequiredAt,
                          );
            if (report.contractReads) {
                this.reads.perOrder += report.contractReads.perOrder;
                this.reads.shared += report.contractReads.shared;
                this.reads.other += report.contractReads.other;
                this.reads.statusBatches +=
                    report.contractReads.statusBatches ?? 0;
            }
        }
        if (
            this.now() - this.startedAt >=
            ORDER_VALIDATION_REPORTING_POLICY.intervalMs
        )
            this.flush();
    }

    flush(): void {
        const endedAt = this.now();
        if (this.batches)
            logger.info(LOG.Progress, {
                component: LOG.Component,
                chainId: this.chainId,
                startedAt: this.startedAt,
                endedAt,
                windowMs: Math.max(0, endedAt - this.startedAt),
                batches: this.batches,
                ...this.counts,
                // Durations add across concurrent batches and can exceed the wall-clock window.
                batchDurationMs: this.batchDurationMs,
                maximumBatchDurationMs: this.maximumBatchDurationMs,
                oldestSampledRequiredAt: this.oldestRequiredAt,
                contractReads: { ...this.reads },
            });
        this.startedAt = endedAt;
        this.batches = 0;
        this.counts = emptyCounts();
        this.batchDurationMs = 0;
        this.maximumBatchDurationMs = 0;
        this.oldestRequiredAt = null;
        this.reads = { perOrder: 0, shared: 0, other: 0, statusBatches: 0 };
    }
}
