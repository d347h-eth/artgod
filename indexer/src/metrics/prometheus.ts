import type { MetricLabels, Metrics, MetricsScrapePort } from "./types.js";

const DEFAULT_PREFIX = "artgod_indexer_";
const DEFAULT_HISTOGRAM_BUCKETS_MS = [
    1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10000,
];

type MetricKind = "counter" | "gauge" | "histogram";

type PromRegistry = {
    contentType: string;
    metrics: () => string | Promise<string>;
    setDefaultLabels: (labels: Record<string, string>) => void;
};

type PromCounter = {
    inc: ((value?: number) => void) &
        ((labels: Record<string, string>, value?: number) => void);
};

type PromGauge = {
    set: ((value: number) => void) &
        ((labels: Record<string, string>, value: number) => void);
};

type PromHistogram = {
    observe: ((value: number) => void) &
        ((labels: Record<string, string>, value: number) => void);
};

type PromClientRuntime = {
    Registry: new () => PromRegistry;
    Counter: new (args: {
        name: string;
        help: string;
        labelNames?: string[];
        registers?: PromRegistry[];
    }) => PromCounter;
    Gauge: new (args: {
        name: string;
        help: string;
        labelNames?: string[];
        registers?: PromRegistry[];
    }) => PromGauge;
    Histogram: new (args: {
        name: string;
        help: string;
        labelNames?: string[];
        buckets?: number[];
        registers?: PromRegistry[];
    }) => PromHistogram;
    collectDefaultMetrics: (args: { register: PromRegistry }) => void;
};

type MetricEntry<TMetric> = {
    metric: TMetric;
    labelNames: readonly string[];
};

let cachedPromClient: Promise<PromClientRuntime | null> | undefined;

export type PrometheusMetricsOptions = {
    prefix?: string;
    defaultLabels?: Record<string, string>;
    histogramBucketsMs?: number[];
    collectProcessMetrics?: boolean;
};

export class PrometheusMetrics implements Metrics, MetricsScrapePort {
    private readonly registry: PromRegistry;
    private readonly prefix: string;
    private readonly histogramBucketsMs: number[];
    private readonly promClient: PromClientRuntime;
    private readonly counters = new Map<string, MetricEntry<PromCounter>>();
    private readonly gauges = new Map<string, MetricEntry<PromGauge>>();
    private readonly histograms = new Map<string, MetricEntry<PromHistogram>>();

    constructor(
        promClient: PromClientRuntime,
        options: PrometheusMetricsOptions = {},
    ) {
        this.promClient = promClient;
        this.registry = new promClient.Registry();
        this.prefix = normalizeMetricPrefix(options.prefix ?? DEFAULT_PREFIX);
        this.histogramBucketsMs = sanitizeHistogramBuckets(
            options.histogramBucketsMs,
        );

        if (options.defaultLabels) {
            this.registry.setDefaultLabels(
                normalizeDefaultLabels(options.defaultLabels),
            );
        }
        if (options.collectProcessMetrics ?? true) {
            promClient.collectDefaultMetrics({ register: this.registry });
        }
    }

    increment(name: string, value = 1, labels: MetricLabels = {}): void {
        const metricName = this.metricName(name, "counter");
        const entry = this.getCounter(metricName, labels, name);
        if (entry.labelNames.length === 0) {
            entry.metric.inc(value);
            return;
        }
        entry.metric.inc(mapLabelValues(entry.labelNames, labels), value);
    }

    gauge(name: string, value: number, labels: MetricLabels = {}): void {
        const metricName = this.metricName(name, "gauge");
        const entry = this.getGauge(metricName, labels, name);
        if (entry.labelNames.length === 0) {
            entry.metric.set(value);
            return;
        }
        entry.metric.set(mapLabelValues(entry.labelNames, labels), value);
    }

    histogram(name: string, value: number, labels: MetricLabels = {}): void {
        const metricName = this.metricName(name, "histogram");
        const entry = this.getHistogram(metricName, labels, name);
        if (entry.labelNames.length === 0) {
            entry.metric.observe(value);
            return;
        }
        entry.metric.observe(mapLabelValues(entry.labelNames, labels), value);
    }

    get contentType(): string {
        return this.registry.contentType;
    }

    async metricsText(): Promise<string> {
        const output = this.registry.metrics();
        if (typeof output === "string") return output;
        return output;
    }

    private getCounter(
        metricName: string,
        labels: MetricLabels,
        inputName: string,
    ): MetricEntry<PromCounter> {
        const key = metricKey(metricName, "counter");
        const cached = this.counters.get(key);
        if (cached) return cached;

        const labelNames = normalizeLabelNames(Object.keys(labels));
        const metric = new this.promClient.Counter({
            name: metricName,
            help: `${inputName} counter`,
            labelNames: [...labelNames],
            registers: [this.registry],
        });
        const entry = { metric, labelNames };
        this.counters.set(key, entry);
        return entry;
    }

    private getGauge(
        metricName: string,
        labels: MetricLabels,
        inputName: string,
    ): MetricEntry<PromGauge> {
        const key = metricKey(metricName, "gauge");
        const cached = this.gauges.get(key);
        if (cached) return cached;

        const labelNames = normalizeLabelNames(Object.keys(labels));
        const metric = new this.promClient.Gauge({
            name: metricName,
            help: `${inputName} gauge`,
            labelNames: [...labelNames],
            registers: [this.registry],
        });
        const entry = { metric, labelNames };
        this.gauges.set(key, entry);
        return entry;
    }

    private getHistogram(
        metricName: string,
        labels: MetricLabels,
        inputName: string,
    ): MetricEntry<PromHistogram> {
        const key = metricKey(metricName, "histogram");
        const cached = this.histograms.get(key);
        if (cached) return cached;

        const labelNames = normalizeLabelNames(Object.keys(labels));
        const metric = new this.promClient.Histogram({
            name: metricName,
            help: `${inputName} histogram`,
            labelNames: [...labelNames],
            buckets: this.histogramBucketsMs,
            registers: [this.registry],
        });
        const entry = { metric, labelNames };
        this.histograms.set(key, entry);
        return entry;
    }

    private metricName(name: string, kind: MetricKind): string {
        const normalized = normalizeMetricName(name);
        const prefixed = `${this.prefix}${normalized}`;
        if (kind === "counter" && !prefixed.endsWith("_total")) {
            return `${prefixed}_total`;
        }
        return prefixed;
    }
}

export async function createPrometheusMetrics(
    options: PrometheusMetricsOptions = {},
): Promise<PrometheusMetrics | null> {
    const promClient = await loadPromClient();
    if (!promClient) return null;
    return new PrometheusMetrics(promClient, options);
}

async function loadPromClient(): Promise<PromClientRuntime | null> {
    if (!cachedPromClient) {
        const packageName = "prom-client";
        cachedPromClient = import(packageName)
            .then((module) => module as unknown as PromClientRuntime)
            .catch(() => null);
    }
    return cachedPromClient;
}

function normalizeMetricPrefix(prefix: string): string {
    const normalized = normalizeMetricName(prefix);
    if (normalized.endsWith("_")) return normalized;
    return `${normalized}_`;
}

function sanitizeHistogramBuckets(
    buckets: number[] | undefined,
): number[] {
    if (!buckets || buckets.length === 0) {
        return DEFAULT_HISTOGRAM_BUCKETS_MS;
    }
    const normalized = buckets
        .filter((bucket) => Number.isFinite(bucket) && bucket > 0)
        .map((bucket) => Number(bucket))
        .sort((a, b) => a - b);
    return normalized.length > 0 ? normalized : DEFAULT_HISTOGRAM_BUCKETS_MS;
}

function normalizeMetricName(name: string): string {
    let normalized = name.trim().toLowerCase();
    normalized = normalized.replace(/[^a-z0-9_]+/g, "_");
    normalized = normalized.replace(/^_+/, "");
    normalized = normalized.replace(/_+/g, "_");
    if (normalized === "") {
        return "metric";
    }
    if (!/^[a-z_]/.test(normalized)) {
        return `m_${normalized}`;
    }
    return normalized;
}

function normalizeLabelName(name: string): string {
    const normalized = normalizeMetricName(name);
    if (!/^[a-z_]/.test(normalized)) {
        return `l_${normalized}`;
    }
    return normalized;
}

function normalizeLabelNames(names: readonly string[]): readonly string[] {
    const deduped = new Set<string>();
    for (const name of names) {
        deduped.add(normalizeLabelName(name));
    }
    return [...deduped].sort();
}

function normalizeDefaultLabels(
    labels: Record<string, string>,
): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(labels)) {
        normalized[normalizeLabelName(key)] = value;
    }
    return normalized;
}

function mapLabelValues(
    expectedNames: readonly string[],
    labels: MetricLabels,
): Record<string, string> {
    const normalizedInput: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(labels)) {
        normalizedInput[normalizeLabelName(rawKey)] = String(rawValue);
    }

    const values: Record<string, string> = {};
    for (const key of expectedNames) {
        values[key] = normalizedInput[key] ?? "";
    }
    return values;
}

function metricKey(metricName: string, kind: MetricKind): string {
    return `${kind}:${metricName}`;
}
