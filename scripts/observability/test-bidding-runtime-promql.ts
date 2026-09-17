import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_METRIC_DEFAULT_LABEL } from "../../shared/observability/metrics/runtime.js";
import {
    BIDDING_RUNTIME_HISTOGRAM_BUCKETS,
    BIDDING_RUNTIME_METRIC_NAME,
} from "../../trading/src/adapters/observability/bidding-runtime-metric-contract.js";
import {
    TRADING_METRICS_PREFIX,
    TRADING_METRICS_WORKER,
} from "../../trading/src/runtime/observability.js";
import {
    buildDashboard,
    histogramOverflowFraction,
    histogramPercentile,
} from "./generate-bidding-runtime-dashboard.js";

// Fixed synthetic scrapes exercise the actual Prometheus engine without live runtime data.
const SAMPLE_INTERVAL = "1m";
const EVALUATION_TIME = "5m";
const DEFAULT_CHAIN_ID = "1";
const OVERFLOW_CHAIN_ID = "2";
const OUTPUT_FILE = "bidding-runtime-promql-tests.json";
const runtimeLabels = [
    RUNTIME_METRIC_DEFAULT_LABEL.Worker,
    RUNTIME_METRIC_DEFAULT_LABEL.ChainId,
];
type HistogramName = keyof typeof BIDDING_RUNTIME_HISTOGRAM_BUCKETS;

function query(expression: string): string {
    return runtimeLabels.reduce(
        (result, label) => result.replaceAll(`$${label}`, ".*"),
        expression.replaceAll("$__rate_interval", EVALUATION_TIME),
    );
}

function labels(chainId = DEFAULT_CHAIN_ID): string {
    return `${RUNTIME_METRIC_DEFAULT_LABEL.Worker}="${TRADING_METRICS_WORKER.BiddingBot}",${RUNTIME_METRIC_DEFAULT_LABEL.ChainId}="${chainId}"`;
}

function series(
    name: HistogramName,
    durationMs: number,
    chainId = DEFAULT_CHAIN_ID,
) {
    const base = `${TRADING_METRICS_PREFIX}${name}`;
    const buckets = BIDDING_RUNTIME_HISTOGRAM_BUCKETS[name];
    return [
        ...buckets.map((boundary) => ({
            series: `${base}_bucket{${labels(chainId)},le="${boundary}"}`,
            values: durationMs <= boundary ? "0+1x5" : "0+0x5",
        })),
        {
            series: `${base}_bucket{${labels(chainId)},le="+Inf"}`,
            values: "0+1x5",
        },
        { series: `${base}_count{${labels(chainId)}}`, values: "0+1x5" },
    ];
}

function check(
    expr: string,
    samples: Array<{ labels: string; value: number }>,
) {
    return {
        expr: query(expr),
        eval_time: EVALUATION_TIME,
        exp_samples: samples,
    };
}

async function main(): Promise<void> {
    const [promtoolPath, artifactDirectory] = process.argv.slice(2);
    if (!promtoolPath || !artifactDirectory) {
        throw new Error(
            "Usage: yarn observability:bidding-dashboard:test-promql <promtool-path> <project-artifact-directory>",
        );
    }
    const dashboard = buildDashboard();
    const panels = dashboard.panels as Array<{
        targets?: Array<{ expr: string }>;
    }>;
    const tests = [
        {
            name: "all dashboard queries parse and evaluate without observations",
            interval: SAMPLE_INTERVAL,
            input_series: [] as Array<{ series: string; values: string }>,
            promql_expr_test: panels.flatMap((panel) =>
                (panel.targets ?? []).map((target) => check(target.expr, [])),
            ),
        },
    ];

    for (const name of [
        BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshDuration,
        BIDDING_RUNTIME_METRIC_NAME.CommandClaimToStrategy,
        BIDDING_RUNTIME_METRIC_NAME.CommandProcessingDuration,
        BIDDING_RUNTIME_METRIC_NAME.StreamEventAge,
    ]) {
        // Assert millisecond accuracy without depending on interpolation's floating-point rounding.
        const percentile = `round(${histogramPercentile(name, 0.95, runtimeLabels)})`;
        const overflow = `${histogramOverflowFraction(name, runtimeLabels)} > 0`;
        for (const [durationMs, expectedP95] of [
            [1_800_000, 1_740_000],
            [10_800_000, 10_440_000],
        ]) {
            tests.push({
                name: `${name}: long observations retain finite p95`,
                interval: SAMPLE_INTERVAL,
                input_series: series(name, durationMs),
                promql_expr_test: [
                    check(percentile, [
                        { labels: `{${labels()}}`, value: expectedP95 },
                    ]),
                    check(overflow, []),
                ],
            });
        }
        const maximum = BIDDING_RUNTIME_HISTOGRAM_BUCKETS[name].at(-1)!;
        tests.push({
            name: `${name}: overflow is explicit and stays scoped to its chain`,
            interval: SAMPLE_INTERVAL,
            input_series: [
                ...series(name, 1_800_000),
                ...series(name, maximum + 1, OVERFLOW_CHAIN_ID),
            ],
            promql_expr_test: [
                check(percentile, [
                    { labels: `{${labels()}}`, value: 1_740_000 },
                ]),
                check(overflow, [
                    { labels: `{${labels(OVERFLOW_CHAIN_ID)}}`, value: 1 },
                ]),
            ],
        });
    }

    const directory = path.resolve(artifactDirectory);
    await mkdir(directory, { recursive: true });
    const output = path.join(directory, OUTPUT_FILE);
    // JSON is also valid YAML; preserve the exact fixture used by promtool for later review.
    await writeFile(
        output,
        JSON.stringify(
            { evaluation_interval: SAMPLE_INTERVAL, tests },
            null,
            2,
        ) + "\n",
    );
    execFileSync(path.resolve(promtoolPath), ["test", "rules", output], {
        stdio: "inherit",
    });
}

await main();
