export type MetricLabels = Record<string, string | number | boolean>;

/** Configures one histogram when the metrics adapter first registers it. */
export type HistogramMetricOptions = {
    /** Overrides the adapter's default bucket boundaries for this histogram. */
    buckets?: readonly number[];
};

export interface Metrics {
    increment(name: string, value?: number, labels?: MetricLabels): void;
    gauge(name: string, value: number, labels?: MetricLabels): void;
    histogram(
        name: string,
        value: number,
        labels?: MetricLabels,
        options?: HistogramMetricOptions,
    ): void;
}

export interface MetricsScrapePort {
    metricsText(): Promise<string>;
    readonly contentType: string;
}
