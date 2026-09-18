import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_METRIC_DEFAULT_LABEL } from "../../shared/observability/metrics/runtime.js";
import {
    BIDDING_RUNTIME_HISTOGRAM_BUCKETS,
    BIDDING_RUNTIME_METRIC_NAME,
    BIDDING_RUNTIME_METRIC_LABEL as label,
    BIDDING_RUNTIME_FORBIDDEN_HIGH_CARDINALITY_LABELS,
    BIDDING_OPEN_SEA_LANE,
    BIDDING_RUNTIME_METRIC_RESULT,
} from "../../trading/src/adapters/observability/bidding-runtime-metric-contract.js";
import {
    TRADING_METRICS_PREFIX,
    TRADING_METRICS_WORKER,
} from "../../trading/src/runtime/observability.js";
import {
    buildDashboard,
    buildBiddingAlertRules,
    BIDDING_ALERT_NAME,
    BIDDING_DASHBOARD_PANEL,
    histogramOverflowFraction,
    histogramPercentile,
} from "./generate-bidding-runtime-dashboard.js";
import {
    biddingRuntimePromqlFixture,
    scrapeSeries,
} from "./bidding-runtime-promql-fixture.js";
import {
    BIDDER_DECISION,
    BIDDER_MARKET_ACTION,
    BIDDER_OBSERVED_POSITION,
    BIDDER_SCAN_RESULT,
} from "../../trading/src/application/use-cases/bidding/bidder.js";
import { BIDDER_TARGET_TYPE } from "../../trading/src/domain/market/strategy/job.js";
import { BIDDING_WORK_STAGE } from "../../trading/src/application/use-cases/bidding/bidding-work-observability.js";
import { BIDDING_HEALTH_COMPONENT } from "../../trading/src/application/use-cases/bidding/sample-bidding-runtime-health.js";
import { BIDDING_COMMAND_QUEUE_STATUS } from "../../trading/src/application/use-cases/bidding/bidding-command-queue-health.js";
import {
    BIDDING_COMMAND_DURABLE_OUTCOME,
    BIDDING_COMMAND_RECONCILIATION_RESULT,
} from "../../trading/src/application/use-cases/bidding/bidding-job-command-reconciler.js";
import { COLLECTION_OFFER_FRESHNESS } from "../../trading/src/application/use-cases/bidding/collection-offer-snapshot-service.js";
import { OPEN_SEA_SNAPSHOT_OPERATION } from "../../trading/src/adapters/opensea/open-sea-collection-offer-source.js";
import { TOKEN_BUCKET_RATE_LIMIT_PRIORITY_LABEL } from "../../trading/src/adapters/support/token-bucket-rate-limiter.js";
import {
    TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT,
    TRADING_JOB_COMMAND_KIND,
} from "../../shared/types/index.js";

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
        title: string;
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

    const fixture = await biddingRuntimePromqlFixture(DEFAULT_CHAIN_ID);
    const otherChain = await biddingRuntimePromqlFixture(OVERFLOW_CHAIN_ID);
    for (const name of BIDDING_RUNTIME_FORBIDDEN_HIGH_CARDINALITY_LABELS) {
        if (new RegExp(`[,{]${name}="`).test(fixture.held))
            throw new Error(`Exporter leaked forbidden label ${name}`);
    }
    const expression = (panel: string, index = 0) => {
        const target = panels.find((item) => item.title === panel)?.targets?.[
            index
        ];
        if (!target)
            throw new Error(`Missing dashboard target ${panel} / ${index}`);
        return target.expr;
    };
    const sample = (
        value: number,
        extra: Record<string, string | boolean> = {},
        chain = DEFAULT_CHAIN_ID,
    ) => ({
        labels: `{${labels(chain)}${Object.entries(extra)
            .map(([key, value]) => `,${key}="${value}"`)
            .join("")}}`,
        value,
    });
    const stage = { [label.Stage]: BIDDING_WORK_STAGE.MarketRead };
    const api = {
        [label.Lane]: BIDDING_OPEN_SEA_LANE.Snapshot,
        [label.Operation]: OPEN_SEA_SNAPSHOT_OPERATION.GetAllOffersPage,
        [label.Priority]: TOKEN_BUCKET_RATE_LIMIT_PRIORITY_LABEL.Background,
    };
    const checks = [
        check(expression(BIDDING_DASHBOARD_PANEL.ScanProgress, 0), [sample(1)]),
        check(expression(BIDDING_DASHBOARD_PANEL.ScanProgress, 1), [sample(3)]),
        check(expression(BIDDING_DASHBOARD_PANEL.ScanProgress, 2), [sample(1)]),
        check(expression(BIDDING_DASHBOARD_PANEL.ScanAge, 0), [sample(240)]),
        check(expression(BIDDING_DASHBOARD_PANEL.ScanAge, 1), [sample(210)]),
        check(expression(BIDDING_DASHBOARD_PANEL.ScanAge, 2), []),
        check(expression(BIDDING_DASHBOARD_PANEL.ActiveWork), [
            sample(1, stage),
        ]),
        check(expression(BIDDING_DASHBOARD_PANEL.WorkAge), [
            sample(240, stage),
        ]),
        check(expression(BIDDING_DASHBOARD_PANEL.OpenSeaInFlight), [
            sample(1, api),
        ]),
        check(expression(BIDDING_DASHBOARD_PANEL.OpenSeaAge), [
            sample(240, api),
        ]),
        check(
            expression(BIDDING_DASHBOARD_PANEL.HealthSuccess),
            Object.values(BIDDING_HEALTH_COMPONENT).map((component) =>
                sample(
                    component === BIDDING_HEALTH_COMPONENT.CommandQueue ? 0 : 1,
                    { [label.Component]: component },
                ),
            ),
        ),
        check(
            expression(BIDDING_DASHBOARD_PANEL.HealthAge),
            Object.values(BIDDING_HEALTH_COMPONENT).map((component) =>
                sample(180, { [label.Component]: component }),
            ),
        ),
        check(
            expression(BIDDING_DASHBOARD_PANEL.QueueDepth),
            Object.values(BIDDING_COMMAND_QUEUE_STATUS).map((status) =>
                sample(
                    status === BIDDING_COMMAND_QUEUE_STATUS.Pending ? 2 : 1,
                    { [label.Status]: status },
                ),
            ),
        ),
        check(expression(BIDDING_DASHBOARD_PANEL.QueueDepth, 1), [sample(1)]),
        check(expression(BIDDING_DASHBOARD_PANEL.QueueAge), [sample(270)]),
        check(
            expression(BIDDING_DASHBOARD_PANEL.DurableOutcomes),
            Object.values(BIDDING_COMMAND_DURABLE_OUTCOME).map((outcome) =>
                sample(1, {
                    [label.CommandKind]: TRADING_JOB_COMMAND_KIND.JobUpdated,
                    [label.Outcome]: outcome,
                }),
            ),
        ),
        check(
            expression(BIDDING_DASHBOARD_PANEL.SnapshotFreshness),
            Object.values(COLLECTION_OFFER_FRESHNESS).map((status) =>
                sample(status === COLLECTION_OFFER_FRESHNESS.Stale ? 2 : 1, {
                    [label.Status]: status,
                }),
            ),
        ),
        check(expression(BIDDING_DASHBOARD_PANEL.SnapshotFreshness, 1), [
            sample(1),
        ]),
        check(expression(BIDDING_DASHBOARD_PANEL.SnapshotAge), [sample(250)]),
        check(expression(BIDDING_DASHBOARD_PANEL.PublicationStatus), [
            sample(4),
        ]),
        check(expression(BIDDING_DASHBOARD_PANEL.PublicationStatus, 1), [
            sample(2),
        ]),
        check(expression(BIDDING_DASHBOARD_PANEL.PublicationStatus, 2), [
            sample(1),
        ]),
        check(expression(BIDDING_DASHBOARD_PANEL.PublicationAge), [
            sample(220),
        ]),
        check(expression(BIDDING_DASHBOARD_PANEL.PublicationAge, 1), [
            sample(250),
        ]),
        check(
            expression(BIDDING_DASHBOARD_PANEL.Positions),
            Object.values(BIDDER_OBSERVED_POSITION).map((position) =>
                sample(
                    position === BIDDER_OBSERVED_POSITION.Unobserved
                        ? 1
                        : position === BIDDER_OBSERVED_POSITION.Losing
                          ? 2
                          : 0,
                    { [label.Position]: position },
                ),
            ),
        ),
        check(
            expression(BIDDING_DASHBOARD_PANEL.Constraints),
            Object.values(TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT).map(
                (constraint) =>
                    sample(
                        constraint ===
                            TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling
                            ? 2
                            : 0,
                        { [label.Constraint]: constraint },
                    ),
            ),
        ),
        check(
            expression(BIDDING_DASHBOARD_PANEL.Decisions),
            Object.values(BIDDER_DECISION).flatMap((decision) =>
                [false, true].map((dryRun) =>
                    sample(1, {
                        [label.Decision]: decision,
                        [label.TargetType]: BIDDER_TARGET_TYPE.Token,
                        [label.DryRun]: dryRun,
                    }),
                ),
            ),
        ),
        check(
            expression(BIDDING_DASHBOARD_PANEL.Effects),
            Object.values(BIDDER_MARKET_ACTION).flatMap((action) =>
                [false, true].flatMap((dryRun) =>
                    [
                        BIDDING_RUNTIME_METRIC_RESULT.Success,
                        BIDDING_RUNTIME_METRIC_RESULT.Failure,
                    ].map((result) =>
                        sample(1, {
                            [label.Action]: action,
                            [label.Result]: result,
                            [label.DryRun]: dryRun,
                        }),
                    ),
                ),
            ),
        ),
    ];
    const failureTargets = panels.find(
        (panel) => panel.title === BIDDING_DASHBOARD_PANEL.Failures,
    )!.targets!;
    for (const [name, results] of [
        [
            BIDDING_RUNTIME_METRIC_NAME.JobScanDuration,
            [
                BIDDER_SCAN_RESULT.Failure,
                BIDDER_SCAN_RESULT.CompletedWithFailures,
            ],
        ],
        [
            BIDDING_RUNTIME_METRIC_NAME.CommandReconciliationDuration,
            [
                BIDDING_COMMAND_RECONCILIATION_RESULT.Failure,
                BIDDING_COMMAND_RECONCILIATION_RESULT.CompletedWithFailures,
            ],
        ],
    ] as const)
        checks.push(
            check(
                failureTargets.find((target) =>
                    target.expr.includes(
                        `${TRADING_METRICS_PREFIX}${name}_count`,
                    ),
                )!.expr,
                results.map((result) => sample(1, { [label.Result]: result })),
            ),
        );
    // The real exporter also emits published and skipped attempts. Neither is a failure.
    checks.push(
        check(
            failureTargets.find((target) =>
                target.expr.includes(
                    `${TRADING_METRICS_PREFIX}${BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionDuration}_count`,
                ),
            )!.expr,
            [sample(1)],
        ),
    );
    tests.push({
        name: "real exporter: populated failures, unfinished work, queue/freshness and decisions",
        interval: SAMPLE_INTERVAL,
        input_series: scrapeSeries(fixture.held),
        promql_expr_test: checks,
    });
    tests.push({
        name: "unfinished age grows without another runtime event",
        interval: SAMPLE_INTERVAL,
        input_series: scrapeSeries(fixture.held),
        promql_expr_test: [
            {
                ...check(expression(BIDDING_DASHBOARD_PANEL.WorkAge), [
                    sample(180, stage),
                ]),
                eval_time: "4m",
            },
            check(expression(BIDDING_DASHBOARD_PANEL.WorkAge), [
                sample(240, stage),
            ]),
        ],
    });
    tests.push({
        name: "selected chain does not borrow another chain's work or freshness",
        interval: SAMPLE_INTERVAL,
        input_series: [
            ...scrapeSeries(fixture.held),
            ...scrapeSeries(otherChain.recovered),
        ],
        promql_expr_test: [
            {
                ...check(expression(BIDDING_DASHBOARD_PANEL.WorkAge), []),
                expr: query(
                    expression(BIDDING_DASHBOARD_PANEL.WorkAge).replaceAll(
                        `$${RUNTIME_METRIC_DEFAULT_LABEL.ChainId}`,
                        OVERFLOW_CHAIN_ID,
                    ),
                ),
            },
            {
                ...check(expression(BIDDING_DASHBOARD_PANEL.WorkAge), [
                    sample(240, stage),
                ]),
                expr: query(
                    expression(BIDDING_DASHBOARD_PANEL.WorkAge).replaceAll(
                        `$${RUNTIME_METRIC_DEFAULT_LABEL.ChainId}`,
                        DEFAULT_CHAIN_ID,
                    ),
                ),
            },
        ],
    });
    tests.push({
        name: "recovery clears in-flight and empty-scope timestamps without epoch-sized ages",
        interval: SAMPLE_INTERVAL,
        input_series: scrapeSeries(fixture.recovered),
        promql_expr_test: [
            ...[
                BIDDING_DASHBOARD_PANEL.WorkAge,
                BIDDING_DASHBOARD_PANEL.OpenSeaAge,
                BIDDING_DASHBOARD_PANEL.QueueAge,
                BIDDING_DASHBOARD_PANEL.SnapshotAge,
                BIDDING_DASHBOARD_PANEL.PublicationAge,
                BIDDING_DASHBOARD_PANEL.NoProgress,
            ].map((panel) => check(expression(panel), [])),
            check(expression(BIDDING_DASHBOARD_PANEL.ScanAge, 1), []),
            check(expression(BIDDING_DASHBOARD_PANEL.ScanAge, 2), [sample(60)]),
            check(expression(BIDDING_DASHBOARD_PANEL.WorkProgress, 1), [
                sample(60, stage),
            ]),
            check(
                expression(BIDDING_DASHBOARD_PANEL.HealthAge),
                Object.values(BIDDING_HEALTH_COMPONENT).map((component) =>
                    sample(60, { [label.Component]: component }),
                ),
            ),
        ],
    });

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
    await writeFile(path.join(directory, "held-runtime.prom"), fixture.held);
    await writeFile(
        path.join(directory, "recovered-runtime.prom"),
        fixture.recovered,
    );
    const alertFile = path.join(directory, "bidding-runtime-alerts.json");
    const alertRules = buildBiddingAlertRules();
    await writeFile(alertFile, JSON.stringify(alertRules, null, 2) + "\n");
    const alertTests = [
        {
            name: "warnings fire only for sustained active work",
            interval: SAMPLE_INTERVAL,
            input_series: scrapeSeries(fixture.held),
            alert_rule_test: alertRules.groups[0].rules.flatMap((rule) => [
                { eval_time: "11m", alertname: rule.alert, exp_alerts: [] },
                { eval_time: "13m", alertname: rule.alert, exp_alerts: [] },
                {
                    eval_time: "14m",
                    alertname: rule.alert,
                    exp_alerts: [
                        {
                            exp_labels: {
                                [RUNTIME_METRIC_DEFAULT_LABEL.Worker]:
                                    TRADING_METRICS_WORKER.BiddingBot,
                                [RUNTIME_METRIC_DEFAULT_LABEL.ChainId]:
                                    DEFAULT_CHAIN_ID,
                                ...rule.labels,
                                ...(rule.alert ===
                                BIDDING_ALERT_NAME.WorkNoProgress
                                    ? stage
                                    : {}),
                            },
                            exp_annotations: rule.annotations,
                        },
                    ],
                },
            ]),
        },
        {
            name: "idle/recovered work does not warn",
            interval: SAMPLE_INTERVAL,
            input_series: scrapeSeries(fixture.recovered),
            alert_rule_test: alertRules.groups[0].rules.map((rule) => ({
                eval_time: "14m",
                alertname: rule.alert,
                exp_alerts: [],
            })),
        },
    ];
    const recoveredSeries = new Map(
        scrapeSeries(fixture.recovered).map((item) => [
            item.series,
            item.values.split("+")[0],
        ]),
    );
    alertTests.push({
        name: "a firing warning resolves after the work finishes",
        interval: SAMPLE_INTERVAL,
        input_series: scrapeSeries(fixture.held).map((item) => ({
            series: item.series,
            values: `${item.values.split("+")[0]}+0x14 ${recoveredSeries.get(item.series) ?? 0}+0x5`,
        })),
        alert_rule_test: alertRules.groups[0].rules.flatMap((rule) => [
            {
                eval_time: "14m",
                alertname: rule.alert,
                exp_alerts: [
                    {
                        exp_labels: {
                            [RUNTIME_METRIC_DEFAULT_LABEL.Worker]:
                                TRADING_METRICS_WORKER.BiddingBot,
                            [RUNTIME_METRIC_DEFAULT_LABEL.ChainId]:
                                DEFAULT_CHAIN_ID,
                            ...rule.labels,
                            ...(rule.alert === BIDDING_ALERT_NAME.WorkNoProgress
                                ? stage
                                : {}),
                        },
                        exp_annotations: rule.annotations,
                    },
                ],
            },
            { eval_time: "15m", alertname: rule.alert, exp_alerts: [] },
        ]),
    });
    alertTests.push({
        name: "ongoing progress suppresses warnings even when work remains active",
        interval: SAMPLE_INTERVAL,
        input_series: scrapeSeries(fixture.held).map((item) => ({
            ...item,
            values: [
                BIDDING_RUNTIME_METRIC_NAME.ScanLastProgressAt,
                BIDDING_RUNTIME_METRIC_NAME.WorkLastProgress,
            ].some((name) =>
                item.series.startsWith(`${TRADING_METRICS_PREFIX}${name}{`),
            )
                ? "1+60x20"
                : item.values,
        })),
        alert_rule_test: alertRules.groups[0].rules.map((rule) => ({
            eval_time: "20m",
            alertname: rule.alert,
            exp_alerts: [],
        })),
    });
    // JSON is also valid YAML; preserve the exact fixture used by promtool for later review.
    await writeFile(
        output,
        JSON.stringify(
            {
                rule_files: [alertFile],
                evaluation_interval: SAMPLE_INTERVAL,
                tests: [...tests, ...alertTests],
            },
            null,
            2,
        ) + "\n",
    );
    execFileSync(path.resolve(promtoolPath), ["test", "rules", output], {
        stdio: "inherit",
    });
}

await main();
