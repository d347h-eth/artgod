export type MetricLabels = Record<string, string | number | boolean>;

export interface Metrics {
    increment(name: string, value?: number, labels?: MetricLabels): void;
    gauge(name: string, value: number, labels?: MetricLabels): void;
    histogram(name: string, value: number, labels?: MetricLabels): void;
}
