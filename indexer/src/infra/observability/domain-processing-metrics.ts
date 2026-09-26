import type { Metrics } from "@artgod/shared/observability/metrics";
import { observeBestEffort } from "../../application/processing-observability.js";
import {
    ORDER_PROCESSING_OPERATION,
    ORDER_VALIDATION_BATCH_COUNTERS,
    ORDER_VALIDATION_PATH,
    type MakerCheckpointReport,
    type OrderProcessingObserver,
    type OrderValidationPath,
} from "../../application/orders/observability.js";
import type { OrderValidationBatchReport } from "../../application/orders/validate-order-demand.js";
import {
    QUEUE_OUTBOX_OPERATION,
    type QueueOutboxObserver,
} from "../../application/queue-outbox/drainer.js";
import { QUEUE_NAMES, type QueueName } from "../../domain/queues.js";
import type { QueueOutboxStatus } from "../../domain/queue-outbox.js";
import type { OrderValidationAdmissionObserver } from "../../ports/order-validation-admission.js";
import type { MakerValidationBatch } from "../../ports/order-validation.js";
import {
    DOMAIN_PROCESSING_METRIC as METRIC,
    DOMAIN_PROCESSING_METRIC_LABEL as LABEL,
    DOMAIN_PROCESSING_RESULT as RESULT,
    MAKER_CHECKPOINT_COUNTERS,
    VALIDATION_READ_COUNTERS,
    MAKER_RECOVERY_OUTCOME,
    PROCESSING_DURATION_BUCKETS_SECONDS,
    DEMAND_AGE_BUCKETS_SECONDS,
} from "./domain-processing-metric-contract.js";

const operations = new Set<string>([
    ...Object.values(ORDER_PROCESSING_OPERATION),
    ...Object.values(QUEUE_OUTBOX_OPERATION),
]);
const queues = new Set<string>(Object.values(QUEUE_NAMES));
const durationOptions = { buckets: PROCESSING_DURATION_BUCKETS_SECONDS };

/** The shared Metrics port owns exporting; this adapter owns bounded workflow series. */
export class DomainProcessingMetrics
    implements
        OrderProcessingObserver,
        OrderValidationAdmissionObserver,
        QueueOutboxObserver
{
    private readonly active = new Map<string, number>();
    constructor(
        private readonly metrics: Metrics,
        private readonly now: () => number = Date.now,
    ) {}

    started(operation: string): (succeeded: boolean) => void {
        // Keep the generic operation port from admitting dynamic identifiers as labels.
        if (!operations.has(operation)) return () => {};
        const labels = { [LABEL.Operation]: operation };
        const start = this.now();
        this.active.set(operation, (this.active.get(operation) ?? 0) + 1);
        observeBestEffort(() =>
            this.metrics.gauge(
                METRIC.Active,
                this.active.get(operation)!,
                labels,
            ),
        );
        let finished = false;
        return (succeeded) => {
            if (finished) return;
            finished = true;
            this.active.set(operation, this.active.get(operation)! - 1);
            observeBestEffort(() =>
                this.metrics.gauge(
                    METRIC.Active,
                    this.active.get(operation)!,
                    labels,
                ),
            );
            const completed = {
                ...labels,
                [LABEL.Result]: succeeded ? RESULT.Success : RESULT.Failure,
            };
            observeBestEffort(() =>
                this.metrics.increment(METRIC.Operations, 1, completed),
            );
            observeBestEffort(() =>
                this.metrics.histogram(
                    METRIC.Duration,
                    Math.max(0, this.now() - start) / 1000,
                    completed,
                    durationOptions,
                ),
            );
        };
    }

    demandBatch(report: OrderValidationBatchReport, nowMs: number): void {
        this.metrics.increment(METRIC.DemandBatches);
        for (const outcome of ORDER_VALIDATION_BATCH_COUNTERS)
            this.metrics.increment(METRIC.DemandOrders, report[outcome], {
                [LABEL.Outcome]: outcome,
            });
        this.metrics.histogram(
            METRIC.DemandDuration,
            Math.max(0, report.durationMs) / 1000,
            undefined,
            durationOptions,
        );
        if (report.oldestRequiredAt !== null)
            this.metrics.histogram(
                METRIC.DemandSampledAge,
                Math.max(0, nowMs - report.oldestRequiredAt) / 1000,
                undefined,
                { buckets: DEMAND_AGE_BUCKETS_SECONDS },
            );
        if (report.contractReads)
            this.contractReads(
                ORDER_VALIDATION_PATH.Demand,
                report.contractReads,
            );
    }

    makerCheckpoint(report: MakerCheckpointReport): void {
        this.metrics.increment(METRIC.MakerCheckpoints, 1, {
            [LABEL.End]: report.stepEnd,
        });
        for (const outcome of MAKER_CHECKPOINT_COUNTERS)
            this.metrics.increment(METRIC.MakerOrders, report[outcome], {
                [LABEL.Outcome]: outcome,
            });
    }

    contractReads(
        path: OrderValidationPath,
        reads: ReturnType<MakerValidationBatch["readCounts"]>,
    ): void {
        for (const kind of VALIDATION_READ_COUNTERS)
            this.metrics.increment(METRIC.ContractReads, reads[kind] ?? 0, {
                [LABEL.Path]: path,
                [LABEL.Kind]: kind,
            });
    }

    admissionState(active: number, waiting: number, capacity: number): void {
        this.metrics.gauge(METRIC.AdmissionActive, active);
        this.metrics.gauge(METRIC.AdmissionWaiting, waiting);
        this.metrics.gauge(METRIC.AdmissionCapacity, capacity);
    }

    admissionWait(durationMs: number, cancelled: boolean): void {
        this.metrics.histogram(
            METRIC.AdmissionWait,
            Math.max(0, durationMs) / 1000,
            { [LABEL.Result]: cancelled ? RESULT.Cancelled : RESULT.Granted },
            durationOptions,
        );
    }

    makerRecovery(checked: number, recovered: number, failed: number): void {
        for (const [outcome, count] of [
            [MAKER_RECOVERY_OUTCOME.Checked, checked],
            [MAKER_RECOVERY_OUTCOME.Recovered, recovered],
            [MAKER_RECOVERY_OUTCOME.Failed, failed],
        ] as const)
            this.metrics.increment(METRIC.Recovery, count, {
                [LABEL.Outcome]: outcome,
            });
    }

    makerReceiptsCleaned(count: number): void {
        this.metrics.increment(METRIC.ReceiptsCleaned, count);
    }

    publication(queueName: QueueName, status: QueueOutboxStatus): void {
        if (queues.has(queueName))
            this.metrics.increment(METRIC.OutboxPublications, 1, {
                [LABEL.Queue]: queueName,
                [LABEL.Status]: status,
            });
    }
}
