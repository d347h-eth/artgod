import type {
    MetricLabels,
    Metrics,
} from "@artgod/shared/observability/metrics";

type Activity = {
    starts: Map<symbol, number>;
    lastProgressAt: number;
    lastSuccessAt: number;
};

export type InFlightMetricNames = {
    active: string;
    oldestStart: string;
    lastProgress: string;
    lastSuccess: string;
};

// Bookkeeping is bounded by active calls and the owner's finite label vocabulary.
// Publish timestamps rather than frozen ages so a scrape can describe a stalled await.
export class InFlightMetrics {
    private readonly activities = new Map<string, Activity>();

    constructor(
        private readonly metrics: Metrics,
        private readonly names: InFlightMetricNames,
        private readonly now: () => number = Date.now,
    ) {}

    start(labels: MetricLabels): (succeeded: boolean) => void {
        const key = JSON.stringify(
            Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)),
        );
        let activity = this.activities.get(key);
        if (!activity) {
            activity = {
                starts: new Map(),
                lastProgressAt: 0,
                lastSuccessAt: 0,
            };
            this.activities.set(key, activity);
        }
        const token = Symbol();
        activity.starts.set(token, this.now());
        activity.lastProgressAt = this.now();
        this.report(activity, labels);
        return (succeeded) => {
            if (!activity.starts.delete(token)) return;
            activity.lastProgressAt = this.now();
            if (succeeded) activity.lastSuccessAt = activity.lastProgressAt;
            this.report(activity, labels);
        };
    }

    private report(activity: Activity, labels: MetricLabels): void {
        const oldest = activity.starts.values().next().value ?? 0;
        this.metrics.gauge(this.names.active, activity.starts.size, labels);
        this.metrics.gauge(this.names.oldestStart, oldest / 1000, labels);
        this.metrics.gauge(
            this.names.lastProgress,
            activity.lastProgressAt / 1000,
            labels,
        );
        this.metrics.gauge(
            this.names.lastSuccess,
            activity.lastSuccessAt / 1000,
            labels,
        );
    }
}
