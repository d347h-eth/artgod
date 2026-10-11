import { logger } from "@artgod/shared/utils";
import {
    LOG_REPORTING_POLICY,
    WindowedLogReporter,
} from "@artgod/shared/observability/log-reporting";
import { ORDER_VALIDATION_DEMAND_LOG as LOG } from "../../domain/order-validation-demand.js";
import type {
    OrderValidationBatchReport,
    OrderValidationDemandReporter,
} from "../../application/orders/validate-order-demand.js";
import { ORDER_VALIDATION_BATCH_COUNTERS as counters } from "../../application/orders/observability.js";

export const ORDER_VALIDATION_REPORTING_POLICY = LOG_REPORTING_POLICY;

const emptyProgress = () => ({
    batches: 0,
    counts: {
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
    },
    batchDurationMs: 0,
    maximumBatchDurationMs: 0,
    oldestRequiredAt: null as number | null,
    reads: { perOrder: 0, shared: 0, other: 0, statusBatches: 0 },
});

/** One bounded aggregate per chain worker/window; no order/maker identifiers or arrays. */
export class OrderValidationDemandProgress implements OrderValidationDemandReporter {
    private readonly progress: WindowedLogReporter<
        ReturnType<typeof emptyProgress>
    >;

    constructor(chainId: number, now: () => number = Date.now) {
        this.progress = new WindowedLogReporter(
            emptyProgress,
            (state, window) => {
                logger.info(LOG.Progress, {
                    component: LOG.Component,
                    chainId,
                    ...window,
                    batches: state.batches,
                    ...state.counts,
                    // Durations add across concurrent batches and can exceed the wall-clock window.
                    batchDurationMs: state.batchDurationMs,
                    maximumBatchDurationMs: state.maximumBatchDurationMs,
                    oldestSampledRequiredAt: state.oldestRequiredAt,
                    contractReads: state.reads,
                });
            },
            now,
        );
    }

    record(report: OrderValidationBatchReport | undefined): void {
        this.progress.record(
            report
                ? (state) => {
                      state.batches++;
                      for (const key of counters)
                          state.counts[key] += report[key];
                      state.batchDurationMs += report.durationMs;
                      state.maximumBatchDurationMs = Math.max(
                          state.maximumBatchDurationMs,
                          report.durationMs,
                      );
                      if (report.oldestRequiredAt !== null)
                          state.oldestRequiredAt =
                              state.oldestRequiredAt === null
                                  ? report.oldestRequiredAt
                                  : Math.min(
                                        state.oldestRequiredAt,
                                        report.oldestRequiredAt,
                                    );
                      if (report.contractReads) {
                          state.reads.perOrder += report.contractReads.perOrder;
                          state.reads.shared += report.contractReads.shared;
                          state.reads.other += report.contractReads.other;
                          state.reads.statusBatches +=
                              report.contractReads.statusBatches ?? 0;
                      }
                  }
                : undefined,
        );
    }

    flush(): void {
        this.progress.flush();
    }
}
