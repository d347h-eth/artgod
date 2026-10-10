import type { Metrics } from "@artgod/shared/observability/metrics";
import type {
    AutomaticSyncObserver,
    AutomaticSyncRangeReport,
} from "../../application/automatic-sync-executor.js";

export const AUTOMATIC_SYNC_METRIC = {
    Ranges: "automatic_sync.ranges",
    Blocks: "automatic_sync.blocks",
    CollectionBlocks: "automatic_sync.collection_blocks",
    Duration: "automatic_sync.range_duration_seconds",
    LastCompletedAt: "automatic_sync.last_completed_timestamp_seconds",
    LastCompletedBlock: "automatic_sync.last_completed_block",
} as const;
export const AUTOMATIC_SYNC_METRIC_LABEL = { Kind: "kind" } as const;
const RANGE_DURATION_BUCKETS_SECONDS = [
    0.1, 0.5, 1, 5, 10, 30, 60, 120, 300, 600,
];

/** Successful work counters, not an inventory of unique stored coverage.
 * A shared N-block range for C collections counts N blocks and N*C collection-blocks.
 * Repairs/recovery can revisit blocks; these counters count committed processing. */
export class AutomaticSyncMetrics implements AutomaticSyncObserver {
    constructor(private readonly metrics: Metrics) {}

    rangeCompleted(report: AutomaticSyncRangeReport): void {
        const labels = { [AUTOMATIC_SYNC_METRIC_LABEL.Kind]: report.kind };
        this.metrics.increment(AUTOMATIC_SYNC_METRIC.Ranges, 1, labels);
        this.metrics.increment(
            AUTOMATIC_SYNC_METRIC.Blocks,
            report.blocksProcessed,
            labels,
        );
        this.metrics.increment(
            AUTOMATIC_SYNC_METRIC.CollectionBlocks,
            report.blocksProcessed * report.collectionsProcessed,
            labels,
        );
        this.metrics.histogram(
            AUTOMATIC_SYNC_METRIC.Duration,
            report.durationMs / 1000,
            labels,
            { buckets: RANGE_DURATION_BUCKETS_SECONDS },
        );
        this.metrics.gauge(
            AUTOMATIC_SYNC_METRIC.LastCompletedAt,
            report.completedAtMs / 1000,
            labels,
        );
        this.metrics.gauge(
            AUTOMATIC_SYNC_METRIC.LastCompletedBlock,
            report.toBlock,
            labels,
        );
    }
}
