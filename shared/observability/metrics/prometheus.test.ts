import { describe, expect, it } from "vitest";
import { noopMetrics } from "./noop.js";
import {
    createPrometheusMetrics,
    type PrometheusMetrics,
} from "./prometheus.js";

const TEST_METRIC_PREFIX = "shared_metrics_test";
const TEST_CUSTOM_HISTOGRAM = "custom_latency";
const TEST_DEFAULT_HISTOGRAM = "default_latency";
const TEST_REGISTERED_HISTOGRAM = "registered_latency";
const TEST_RESULT_LABEL = "result";
const TEST_LATER_LABEL = "later";
const TEST_CUSTOM_BUCKETS = [0, 10, 50, 100] as const;
const TEST_DEFAULT_BUCKETS = [5, 15] as const;
const TEST_FIRST_BUCKETS = [1, 2] as const;
const TEST_LATER_BUCKETS = [3, 4] as const;

describe("PrometheusMetrics histogram buckets", () => {
    it("uses per-metric buckets without changing the adapter defaults", async () => {
        const metrics = await createMetrics();

        metrics.histogram(
            TEST_CUSTOM_HISTOGRAM,
            75,
            { [TEST_RESULT_LABEL]: "success" },
            { buckets: TEST_CUSTOM_BUCKETS },
        );
        metrics.histogram(TEST_DEFAULT_HISTOGRAM, 12);

        const scrape = await metrics.metricsText();
        expect(bucketBoundaries(scrape, TEST_CUSTOM_HISTOGRAM)).toEqual([
            "0",
            "10",
            "50",
            "100",
            "+Inf",
        ]);
        expect(bucketBoundaries(scrape, TEST_DEFAULT_HISTOGRAM)).toEqual([
            "5",
            "15",
            "+Inf",
        ]);
    });

    it("keeps the first registered bucket and label schemas", async () => {
        const metrics = await createMetrics();

        metrics.histogram(
            TEST_REGISTERED_HISTOGRAM,
            1,
            { [TEST_RESULT_LABEL]: "first" },
            { buckets: TEST_FIRST_BUCKETS },
        );
        metrics.histogram(
            TEST_REGISTERED_HISTOGRAM,
            3,
            {
                [TEST_RESULT_LABEL]: "second",
                [TEST_LATER_LABEL]: "ignored",
            },
            { buckets: TEST_LATER_BUCKETS },
        );

        const scrape = await metrics.metricsText();
        expect(bucketBoundaries(scrape, TEST_REGISTERED_HISTOGRAM)).toEqual([
            "1",
            "2",
            "+Inf",
            "1",
            "2",
            "+Inf",
        ]);
        expect(scrape).not.toContain(`${TEST_LATER_LABEL}=`);
    });

    it("accepts per-metric buckets through the no-op adapter", () => {
        expect(() =>
            noopMetrics.histogram(TEST_CUSTOM_HISTOGRAM, 1, undefined, {
                buckets: TEST_CUSTOM_BUCKETS,
            }),
        ).not.toThrow();
    });

    it("emits unique cumulative samples for repeated and unordered boundaries", async () => {
        const metrics = await createPrometheusMetrics({
            prefix: TEST_METRIC_PREFIX,
            histogramBucketsMs: [2, 1, 1],
            collectProcessMetrics: false,
        });
        if (!metrics) throw new Error("prom-client is required for this test");
        metrics.histogram(TEST_DEFAULT_HISTOGRAM, 1);
        metrics.histogram(TEST_CUSTOM_HISTOGRAM, 1, undefined, {
            buckets: [2, 1, 0, 1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY],
        });
        metrics.histogram(TEST_CUSTOM_HISTOGRAM, 3);

        const scrape = await metrics.metricsText();
        expect(bucketBoundaries(scrape, TEST_DEFAULT_HISTOGRAM)).toEqual([
            "1",
            "2",
            "+Inf",
        ]);
        expect(bucketBoundaries(scrape, TEST_CUSTOM_HISTOGRAM)).toEqual([
            "0",
            "1",
            "2",
            "+Inf",
        ]);
        const counts = (name: string) =>
            scrape
                .split("\n")
                .filter((line) =>
                    line.startsWith(`${TEST_METRIC_PREFIX}_${name}_bucket{`),
                )
                .map((line) => Number(line.slice(line.lastIndexOf(" ") + 1)));
        expect(counts(TEST_DEFAULT_HISTOGRAM)).toEqual([1, 1, 1]);
        expect(counts(TEST_CUSTOM_HISTOGRAM)).toEqual([0, 1, 1, 2]);
        expect(scrape).toContain(
            `${TEST_METRIC_PREFIX}_${TEST_CUSTOM_HISTOGRAM}_count 2`,
        );
    });
});

async function createMetrics(): Promise<PrometheusMetrics> {
    const metrics = await createPrometheusMetrics({
        prefix: TEST_METRIC_PREFIX,
        histogramBucketsMs: [...TEST_DEFAULT_BUCKETS],
        collectProcessMetrics: false,
    });
    if (!metrics) {
        throw new Error("prom-client is required for this test");
    }
    return metrics;
}

function bucketBoundaries(scrape: string, metricName: string): string[] {
    const prefix = `${TEST_METRIC_PREFIX}_${metricName}_bucket`;
    return scrape
        .split("\n")
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.match(/le="([^"]+)"/)?.[1])
        .filter((boundary): boundary is string => boundary !== undefined);
}
