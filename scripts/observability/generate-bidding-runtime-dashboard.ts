import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format } from "prettier";
import { RUNTIME_METRIC_DEFAULT_LABEL } from "../../shared/observability/metrics/runtime.js";
import { OPEN_SEA_STREAM_EVENT_OUTCOME } from "../../trading/src/adapters/opensea/open-sea-event-stream.js";
import { COLLECTION_OFFER_SNAPSHOT_REFRESH_RESULT } from "../../trading/src/application/use-cases/bidding/collection-offer-snapshot-service.js";
import {
    BIDDING_RUNTIME_FORBIDDEN_HIGH_CARDINALITY_LABELS,
    BIDDING_RUNTIME_CONFIGURATION_SETTING,
    BIDDING_RUNTIME_METRIC_LABEL,
    BIDDING_RUNTIME_METRIC_NAME,
    BIDDING_RUNTIME_METRIC_RESULT,
    BIDDING_RUNTIME_HISTOGRAM_BUCKETS,
} from "../../trading/src/adapters/observability/bidding-runtime-metric-contract.js";
import {
    TRADING_METRICS_PREFIX,
    TRADING_METRICS_WORKER,
} from "../../trading/src/runtime/observability.js";
import { BIDDER_SCAN_RESULT } from "../../trading/src/application/use-cases/bidding/bidder.js";
import { BIDDING_COMMAND_RECONCILIATION_RESULT } from "../../trading/src/application/use-cases/bidding/bidding-job-command-reconciler.js";

const DASHBOARD_UID = "artgod-bidding-runtime";
const DASHBOARD_TITLE = "ArtGod Bidding Runtime Overview";
const DASHBOARD_OUTPUT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../observability/grafana/provisioning/dashboards/bidding-runtime-overview.json",
);
const ALERT_OUTPUT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../observability/prometheus/bidding-runtime-alerts.json",
);

// These operational warnings request inspection; they never retry or cancel marketplace work.
export const BIDDING_PROGRESS_WARNING = {
    idleSeconds: 600,
    pendingDuration: "2m",
} as const;
export const BIDDING_ALERT_NAME = {
    ScanNoProgress: "ArtGodBiddingScanNoProgress",
    WorkNoProgress: "ArtGodBiddingWorkNoProgress",
} as const;
export const BIDDING_DASHBOARD_PANEL = {
    ScanProgress: "Current Scan Progress",
    ScanAge: "Current Scan and Last Success Age",
    ActiveWork: "Active Work Stages",
    WorkAge: "Oldest Unfinished Work",
    WorkProgress: "Work Stage Progress and Success Age",
    OpenSeaInFlight: "OpenSea Calls in Flight",
    OpenSeaAge: "Oldest OpenSea Call",
    HealthSuccess: "Latest Health Sample Succeeded",
    HealthAge: "Last Successful Health Sample Age",
    NoProgress: "Work With No Progress",
    QueueDepth: "Durable Command Backlog",
    QueueAge: "Oldest Pending Command Age",
    DurableOutcomes: "Durable Command Outcomes",
    SnapshotFreshness: "Market Data Freshness",
    SnapshotAge: "Oldest Complete Market Data Age",
    PublicationStatus: "Bid-Book Publication Status",
    PublicationAge: "Oldest Bid-Book Publication Age",
    FreshnessTtl: "Configured Market Data Freshness Bounds",
    FreshnessMultiplier: "Configured Fetch Duration Multiplier",
    Decisions: "Bidding Decision Intents",
    Positions: "Last-Known Job Positions",
    Constraints: "Last-Known Job Constraints",
    Effects: "Marketplace Action Outcomes",
    Failures: "Process-Lifetime Failures",
} as const;

const PROMETHEUS_DATASOURCE = {
    type: "prometheus",
    uid: "prometheus",
} as const;

// These are prom-client's stable process metric names, outside ArtGod's metric namespace.
const PROM_CLIENT_METRIC_NAME = {
    ProcessStartTime: "process_start_time_seconds",
    ProcessResidentMemory: "process_resident_memory_bytes",
    ProcessCpu: "process_cpu_seconds_total",
    EventLoopLagP99: "nodejs_eventloop_lag_p99_seconds",
} as const;

const DASHBOARD_VARIABLE = RUNTIME_METRIC_DEFAULT_LABEL;

// Prometheus owns this generated histogram label.
const PROMETHEUS_HISTOGRAM_BOUND_LABEL = "le";

const BIDDING_METRIC_REFERENCE_PATTERN = new RegExp(
    `${escapeRegularExpression(TRADING_METRICS_PREFIX)}[a-zA-Z_:][a-zA-Z0-9_:]*`,
    "g",
);

type MetricName =
    (typeof BIDDING_RUNTIME_METRIC_NAME)[keyof typeof BIDDING_RUNTIME_METRIC_NAME];

type HistogramMetricName = keyof typeof BIDDING_RUNTIME_HISTOGRAM_BUCKETS;

// These labels identify the measured work and its unit in the overflow panel.
const HISTOGRAM_MEASUREMENTS: Record<HistogramMetricName, string> = {
    [BIDDING_RUNTIME_METRIC_NAME.OpenSeaOperationDuration]: "OpenSea call (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.OpenSeaRateLimitWait]:
        "OpenSea rate-limit wait (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.RuntimeBootstrapPhaseDuration]:
        "startup phase (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.RuntimeTimeToReady]: "time to ready (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.JobScanDuration]: "job scan (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.JobRefreshQueueWait]: "job refresh queue (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.JobRefreshDuration]: "job refresh (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.MarketActionDuration]:
        "marketplace action (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.CommandReconciliationDuration]:
        "command reconciliation (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.CommandReconciliationBatchSize]:
        "commands per reconciliation",
    [BIDDING_RUNTIME_METRIC_NAME.CommandQueueWait]: "command queue (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.CommandClaimToStrategy]:
        "command claim to strategy (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.CommandCreatedToStrategy]:
        "command creation to strategy (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.CommandProcessingDuration]:
        "command attempt (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.HotRefreshQueueWait]:
        "inbound refresh queue (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.HotRefreshPassDuration]:
        "inbound refresh pass (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.HotRefreshPassEvents]:
        "events per inbound refresh pass",
    [BIDDING_RUNTIME_METRIC_NAME.HotRefreshPassSignals]:
        "signals per inbound refresh pass",
    [BIDDING_RUNTIME_METRIC_NAME.StreamEventAge]: "inbound event age (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.StreamDispatchDuration]:
        "inbound dispatch (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshDuration]: "offer sync (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshPages]: "pages per offer sync",
    [BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshOffers]:
        "offers per offer sync",
    [BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionQueueWait]:
        "bid-book update queue (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionDuration]:
        "bid-book update (ms)",
    [BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionRows]:
        "offers per bid-book update",
};

type DashboardTarget = {
    expr: string;
    legendFormat: string;
};

type PanelUnit =
    | "bytes"
    | "ms"
    | "ops"
    | "percentunit"
    | "reqps"
    | "s"
    | "short";

type DashboardPanel = Record<string, unknown>;

const label = BIDDING_RUNTIME_METRIC_LABEL;
const result = BIDDING_RUNTIME_METRIC_RESULT;
const snapshotRejectedResultPattern = [
    COLLECTION_OFFER_SNAPSHOT_REFRESH_RESULT.Partial,
    COLLECTION_OFFER_SNAPSHOT_REFRESH_RESULT.Error,
]
    .map(escapeRegularExpression)
    .join("|");

function metricName(name: MetricName): string {
    return `${TRADING_METRICS_PREFIX}${name}`;
}

function histogramMetricName(
    name: MetricName,
    suffix: "bucket" | "count" | "sum",
): string {
    return `${metricName(name)}_${suffix}`;
}

function matcher(
    labelName: string,
    operator: "=" | "=~",
    value: string,
): string {
    return `${labelName}${operator}"${value}"`;
}

function scoped(extraMatchers: readonly string[] = []): string {
    return `{${[
        matcher(
            DASHBOARD_VARIABLE.Worker,
            "=~",
            `$${DASHBOARD_VARIABLE.Worker}`,
        ),
        matcher(
            DASHBOARD_VARIABLE.ChainId,
            "=~",
            `$${DASHBOARD_VARIABLE.ChainId}`,
        ),
        ...extraMatchers,
    ].join(",")}}`;
}

function groupBy(labels: readonly string[]): string {
    return labels.join(", ");
}

function rateOf(
    name: MetricName,
    labels: readonly string[],
    extraMatchers: readonly string[] = [],
): string {
    return `sum by (${groupBy(labels)}) (rate(${metricName(name)}${scoped(extraMatchers)}[$__rate_interval]))`;
}

function maxOf(
    name: MetricName,
    labels: readonly string[],
    extraMatchers: readonly string[] = [],
): string {
    return `max by (${groupBy(labels)}) (${metricName(name)}${scoped(extraMatchers)})`;
}

function sumOf(
    name: MetricName,
    labels: readonly string[],
    extraMatchers: readonly string[] = [],
): string {
    return `sum by (${groupBy(labels)}) (${metricName(name)}${scoped(extraMatchers)})`;
}

// Zero means never observed or no active work. Excluding it prevents epoch-sized false ages.
export function timestampAge(
    name: MetricName,
    labels: readonly string[],
    extraMatchers: readonly string[] = [],
): string {
    return `clamp_min(time() - min by (${groupBy(labels)}) (${metricName(name)}${scoped(extraMatchers)} > 0), 0)`;
}

function scanIdleAge(labels: readonly string[]): string {
    return `${timestampAge(BIDDING_RUNTIME_METRIC_NAME.ScanLastProgressAt, labels)} and (${maxOf(BIDDING_RUNTIME_METRIC_NAME.ScanActive, labels)} > 0)`;
}

export function buildBiddingAlertRules() {
    const runtimeLabels = [
        DASHBOARD_VARIABLE.Worker,
        DASHBOARD_VARIABLE.ChainId,
    ];
    const workLabels = [...runtimeLabels, label.Stage];
    const expression = (query: string) =>
        query
            .replaceAll(
                `$${DASHBOARD_VARIABLE.Worker}`,
                TRADING_METRICS_WORKER.BiddingBot,
            )
            .replaceAll(`$${DASHBOARD_VARIABLE.ChainId}`, ".*");
    return {
        groups: [
            {
                name: "artgod-bidding-progress",
                rules: [
                    {
                        alert: BIDDING_ALERT_NAME.ScanNoProgress,
                        expr: expression(
                            `(${scanIdleAge(runtimeLabels)}) > ${BIDDING_PROGRESS_WARNING.idleSeconds}`,
                        ),
                        for: BIDDING_PROGRESS_WARNING.pendingDuration,
                        labels: { severity: "warning" },
                        annotations: {
                            summary:
                                "Active bidding scan has no settled-job progress",
                            description:
                                "Inspect active stages, OpenSea calls and logs. Long admitted work may be legitimate; this warning does not authorize retrying marketplace writes.",
                        },
                    },
                    {
                        alert: BIDDING_ALERT_NAME.WorkNoProgress,
                        expr: expression(
                            `(${timestampAge(BIDDING_RUNTIME_METRIC_NAME.WorkLastProgress, workLabels)} and (${sumOf(BIDDING_RUNTIME_METRIC_NAME.WorkActive, workLabels)} > 0)) > ${BIDDING_PROGRESS_WARNING.idleSeconds}`,
                        ),
                        for: BIDDING_PROGRESS_WARNING.pendingDuration,
                        labels: { severity: "warning" },
                        annotations: {
                            summary:
                                "Active bidding stage has no start or completion progress",
                            description:
                                "Inspect the stage and its child operations. A long traversal can still be progressing internally; this is an inspection warning, not proof of a deadlock.",
                        },
                    },
                ],
            },
        ],
    };
}

// Omit a percentile outside the recorded range instead of reporting the final finite boundary.
export function histogramPercentile(
    name: HistogramMetricName,
    percentile: number,
    labels: readonly string[],
    extraMatchers: readonly string[] = [],
): string {
    const histogramLabels = [PROMETHEUS_HISTOGRAM_BOUND_LABEL, ...labels];
    const quantile = `histogram_quantile(${percentile}, sum by (${groupBy(histogramLabels)}) (rate(${histogramMetricName(name, "bucket")}${scoped(extraMatchers)}[$__rate_interval])))`;
    return `${quantile} and (${histogramFiniteFraction(name, labels, extraMatchers)} >= ${percentile})`;
}

function histogramFiniteFraction(
    name: HistogramMetricName,
    labels: readonly string[],
    extraMatchers: readonly string[] = [],
): string {
    const maximum = BIDDING_RUNTIME_HISTOGRAM_BUCKETS[name].at(-1)!;
    const withinRange = [
        ...extraMatchers,
        matcher(PROMETHEUS_HISTOGRAM_BOUND_LABEL, "=", String(maximum)),
    ];
    return `sum by (${groupBy(labels)}) (rate(${histogramMetricName(name, "bucket")}${scoped(withinRange)}[$__rate_interval])) / ${histogramCountRate(name, labels, extraMatchers)}`;
}

// Report the fraction of completed observations above the last finite histogram boundary.
export function histogramOverflowFraction(
    name: HistogramMetricName,
    labels: readonly string[],
): string {
    return `clamp_min(1 - (${histogramFiniteFraction(name, labels)}), 0)`;
}

function histogramCountRate(
    name: MetricName,
    labels: readonly string[],
    extraMatchers: readonly string[] = [],
): string {
    return `sum by (${groupBy(labels)}) (rate(${histogramMetricName(name, "count")}${scoped(extraMatchers)}[$__rate_interval]))`;
}

function histogramCount(
    name: MetricName,
    labels: readonly string[],
    extraMatchers: readonly string[] = [],
): string {
    return `sum by (${groupBy(labels)}) (${histogramMetricName(name, "count")}${scoped(extraMatchers)})`;
}

function histogramLifetimeAverage(
    name: MetricName,
    labels: readonly string[],
): string {
    const grouping = groupBy(labels);
    return `sum by (${grouping}) (${histogramMetricName(name, "sum")}${scoped()}) / clamp_min(sum by (${grouping}) (${histogramMetricName(name, "count")}${scoped()}), 1)`;
}

function legend(...labels: readonly string[]): string {
    return labels.map((labelName) => `{{${labelName}}}`).join(" / ");
}

function target(expr: string, legendFormat: string): DashboardTarget {
    const missingRuntimeLabels = [
        DASHBOARD_VARIABLE.Worker,
        DASHBOARD_VARIABLE.ChainId,
    ].filter((labelName) => !legendFormat.includes(`{{${labelName}}}`));
    const runtimePrefix = legend(...missingRuntimeLabels);
    return {
        expr,
        legendFormat: [runtimePrefix, legendFormat]
            .filter((part) => part.length > 0)
            .join(" / "),
    };
}

class DashboardLayout {
    readonly panels: DashboardPanel[] = [];
    private nextPanelId = 1;
    private nextRowId = 1001;
    private x = 0;
    private y = 0;

    row(title: string): void {
        if (this.x !== 0) {
            this.y += 8;
            this.x = 0;
        }
        this.panels.push({
            collapsed: false,
            gridPos: { h: 1, w: 24, x: 0, y: this.y },
            id: this.nextRowId,
            panels: [],
            title,
            type: "row",
        });
        this.nextRowId += 1;
        this.y += 1;
    }

    timeseries(
        title: string,
        unit: PanelUnit,
        targets: readonly DashboardTarget[],
        description: string,
    ): void {
        if (this.x === 24) {
            this.x = 0;
            this.y += 8;
        }

        this.panels.push({
            datasource: PROMETHEUS_DATASOURCE,
            description,
            fieldConfig: {
                defaults: {
                    color: { mode: "palette-classic" },
                    mappings: [],
                    unit,
                },
                overrides: [],
            },
            gridPos: { h: 8, w: 8, x: this.x, y: this.y },
            id: this.nextPanelId,
            options: {
                legend: {
                    calcs: [],
                    displayMode: "list",
                    placement: "bottom",
                    showLegend: true,
                },
                tooltip: {
                    mode: "multi",
                    sort: "desc",
                },
            },
            targets: targets.map((item, index) => ({
                editorMode: "code",
                expr: item.expr,
                legendFormat: item.legendFormat,
                range: true,
                refId: String.fromCharCode("A".charCodeAt(0) + index),
            })),
            title,
            type: "timeseries",
        });
        this.nextPanelId += 1;
        this.x += 8;
    }
}

// Build the reviewable Grafana artifact without performing file writes.
export function buildDashboard(): Record<string, unknown> {
    const layout = new DashboardLayout();
    const runtimeLabels = [
        DASHBOARD_VARIABLE.Worker,
        DASHBOARD_VARIABLE.ChainId,
    ];

    const workLabels = [...runtimeLabels, label.Stage];
    const apiLabels = [
        ...runtimeLabels,
        label.Lane,
        label.Operation,
        label.Priority,
    ];
    layout.row("Current Work and Collector Health");
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.ScanProgress,
        "short",
        [
            target(
                maxOf(BIDDING_RUNTIME_METRIC_NAME.ScanActive, runtimeLabels),
                "scan active (0/1)",
            ),
            target(
                maxOf(BIDDING_RUNTIME_METRIC_NAME.JobScanSize, runtimeLabels),
                "jobs in latest scan",
            ),
            target(
                maxOf(
                    BIDDING_RUNTIME_METRIC_NAME.ScanCompletedJobs,
                    runtimeLabels,
                ),
                "jobs settled in latest scan",
            ),
        ],
        "Current or most recent scan inventory and settled jobs. Settled includes failed jobs and waiters discarded on Stop; it does not mean successful bids. Counts reset at scan start.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.ScanAge,
        "s",
        [
            target(
                `${timestampAge(BIDDING_RUNTIME_METRIC_NAME.ScanStartedAt, runtimeLabels)} and (${maxOf(BIDDING_RUNTIME_METRIC_NAME.ScanActive, runtimeLabels)} > 0)`,
                "active scan age",
            ),
            target(
                scanIdleAge(runtimeLabels),
                "active scan time without settled-job progress",
            ),
            target(
                timestampAge(
                    BIDDING_RUNTIME_METRIC_NAME.ScanLastSuccessAt,
                    runtimeLabels,
                ),
                "last fully successful scan age",
            ),
        ],
        "Ages keep increasing without new runtime events. Inactive scan age is omitted; absent success means no successful scan has been observed in this process.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.ActiveWork,
        "short",
        [
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.WorkActive, workLabels),
                legend(label.Stage),
            ),
        ],
        "Unfinished operations by bounded stage. Stages can nest, so adding stage counts is not a count of distinct jobs.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.WorkAge,
        "s",
        [
            target(
                timestampAge(
                    BIDDING_RUNTIME_METRIC_NAME.WorkOldestStart,
                    workLabels,
                ),
                legend(label.Stage),
            ),
        ],
        "Age of the oldest unfinished operation in each stage, including startup and durable-command work. Empty stages are omitted, not reported as an epoch-sized age.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.OpenSeaInFlight,
        "short",
        [
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.OpenSeaInFlight, apiLabels),
                legend(label.Lane, label.Operation, label.Priority),
            ),
        ],
        "Calls currently inside the API/SDK boundary. Local rate-limit waiting is separate; no placement or cancellation retry policy is changed.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.OpenSeaAge,
        "s",
        [
            target(
                timestampAge(
                    BIDDING_RUNTIME_METRIC_NAME.OpenSeaOldestStart,
                    apiLabels,
                ),
                legend(label.Lane, label.Operation, label.Priority),
            ),
        ],
        "Oldest API/SDK call age, still visible before any duration observation completes. All completed calls clear their in-flight timestamp.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.HealthSuccess,
        "short",
        [
            target(
                maxOf(BIDDING_RUNTIME_METRIC_NAME.HealthSampleSuccess, [
                    ...runtimeLabels,
                    label.Component,
                ]),
                legend(label.Component),
            ),
        ],
        "Latest completed owner read: 1 succeeded, 0 failed; absent means not yet observed. Health gauges retain the last good read after failure. This is independent of exporter availability and business progress.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.HealthAge,
        "s",
        [
            target(
                timestampAge(BIDDING_RUNTIME_METRIC_NAME.HealthLastSuccess, [
                    ...runtimeLabels,
                    label.Component,
                ]),
                legend(label.Component),
            ),
        ],
        "Age of each owner's last successful sample. Sampling runs immediately and then at the configured health cadence without overlapping reads or database work in scrape handlers. Compare with configured health_poll_ms; a stale sample is not fresh runtime evidence.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.NoProgress,
        "s",
        [
            target(
                `(${scanIdleAge(runtimeLabels)}) > ${BIDDING_PROGRESS_WARNING.idleSeconds}`,
                "scan without settled-job progress",
            ),
            target(
                `(${timestampAge(BIDDING_RUNTIME_METRIC_NAME.WorkLastProgress, workLabels)} and (${sumOf(BIDDING_RUNTIME_METRIC_NAME.WorkActive, workLabels)} > 0)) > ${BIDDING_PROGRESS_WARNING.idleSeconds}`,
                legend(label.Stage),
            ),
        ],
        `Only active work without boundary progress for more than ${BIDDING_PROGRESS_WARNING.idleSeconds} seconds is shown. Matching Prometheus warnings require another ${BIDDING_PROGRESS_WARNING.pendingDuration}. Inspect child operations and logs; long work is not necessarily deadlocked. No automatic recovery or external notification delivery is configured here.`,
    );

    layout.row("Durable Commands and Data Freshness");
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.QueueDepth,
        "short",
        [
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.CommandQueueDepth, [
                    ...runtimeLabels,
                    label.Status,
                ]),
                legend(label.Status),
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.CommandStaleProcessing,
                    runtimeLabels,
                ),
                "stale processing (subset)",
            ),
        ],
        "Last sampled durable rows by status, excluding completed history. Stale processing is the reclaimable subset under the existing claim-timeout policy, not another queue status. Check collector health before interpreting retained values.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.QueueAge,
        "s",
        [
            target(
                timestampAge(
                    BIDDING_RUNTIME_METRIC_NAME.CommandOldestPendingAt,
                    runtimeLabels,
                ),
                "oldest pending or retrying command",
            ),
        ],
        "Creation age of the oldest pending or retryable command, before it is claimed. Empty queues are omitted. A failed/stale health sample can retain an old queue timestamp.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.DurableOutcomes,
        "short",
        [
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.CommandDurableOutcomes, [
                    ...runtimeLabels,
                    label.CommandKind,
                    label.Outcome,
                ]),
                legend(label.CommandKind, label.Outcome),
            ),
        ],
        "Process-lifetime transitions observed after successful persistence: completed, retry scheduled, terminal failure, and stale-claim recovery. These are not unique-command totals or durable audit history across restarts.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.SnapshotFreshness,
        "short",
        [
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.SnapshotFreshness, [
                    ...runtimeLabels,
                    label.Status,
                ]),
                legend(label.Status),
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.SnapshotBackoff,
                    runtimeLabels,
                ),
                "collections in backoff (overlapping subset)",
            ),
        ],
        "Watched collections with fresh, stale or missing complete market data, evaluated by the actual adaptive TTL policy. Backoff may overlap any freshness state. Partial/error fetches never reset complete-data age.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.SnapshotAge,
        "s",
        [
            target(
                timestampAge(
                    BIDDING_RUNTIME_METRIC_NAME.SnapshotOldestCompleteAt,
                    runtimeLabels,
                ),
                "oldest complete refresh",
            ),
        ],
        "Oldest successful complete refresh among watched collections. Missing collections have no timestamp and are counted separately, so an empty age graph does not prove health.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.PublicationStatus,
        "short",
        [
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.PublicationWatched,
                    runtimeLabels,
                ),
                "watched collections",
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.PublicationMissing,
                    runtimeLabels,
                ),
                "no publication observed this process",
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.PublicationLagging,
                    runtimeLabels,
                ),
                "newer complete market data awaiting publication",
            ),
        ],
        "Display publication is independent of market-data freshness. Missing and lagging can overlap. Startup cannot attest to an older persisted bid book until this process publishes it; removed collections leave this scope.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.PublicationAge,
        "s",
        [
            target(
                timestampAge(
                    BIDDING_RUNTIME_METRIC_NAME.PublicationOldestAt,
                    runtimeLabels,
                ),
                "oldest successful publication",
            ),
            target(
                timestampAge(
                    BIDDING_RUNTIME_METRIC_NAME.PublicationOldestSnapshotAt,
                    runtimeLabels,
                ),
                "oldest published market data",
            ),
        ],
        "A recently written bid book can contain older market data. Failed writes preserve the previous successful publication timestamps; successful fetches alone do not reset them.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.FreshnessTtl,
        "ms",
        [
            target(
                maxOf(
                    BIDDING_RUNTIME_METRIC_NAME.RuntimeConfiguration,
                    [...runtimeLabels, label.Setting],
                    [
                        matcher(
                            label.Setting,
                            "=~",
                            [
                                BIDDING_RUNTIME_CONFIGURATION_SETTING.SnapshotTtlMs,
                                BIDDING_RUNTIME_CONFIGURATION_SETTING.SnapshotMaxTtlMs,
                            ].join("|"),
                        ),
                    ],
                ),
                legend(label.Setting),
            ),
        ],
        "Base and maximum adaptive freshness TTL. The runtime combines these with last fetch duration and the configured multiplier; these are bounds, not per-collection effective TTLs.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.FreshnessMultiplier,
        "short",
        [
            target(
                maxOf(
                    BIDDING_RUNTIME_METRIC_NAME.RuntimeConfiguration,
                    runtimeLabels,
                    [
                        matcher(
                            label.Setting,
                            "=",
                            BIDDING_RUNTIME_CONFIGURATION_SETTING.SnapshotTtlMultiplier,
                        ),
                    ],
                ),
                "fetch duration multiplier",
            ),
        ],
        "Dimensionless multiplier applied to the previous complete fetch duration by the market-data freshness policy.",
    );

    layout.row("Bidding Decisions and Known Positions");
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.Decisions,
        "short",
        [
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.Decisions, [
                    ...runtimeLabels,
                    label.Decision,
                    label.TargetType,
                    label.DryRun,
                ]),
                legend(label.Decision, label.TargetType, label.DryRun),
            ),
        ],
        "Process-lifetime strategy intentions: place, renew, adjust, maintain winning/capped, reuse target, or zero-ceiling skip/cancel. Intent is recorded before effects and can be followed by a failed action. Dry-run intent is separate.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.Positions,
        "short",
        [
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.JobPositions, [
                    ...runtimeLabels,
                    label.Position,
                ]),
                legend(label.Position),
            ),
        ],
        "Last-known bot-owned positions for currently scheduled jobs, including unobserved jobs. Positions can be restored from durable state or become stale; they are not independent proof of current marketplace leadership.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.Constraints,
        "short",
        [
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.JobConstraints, [
                    ...runtimeLabels,
                    label.Constraint,
                ]),
                legend(label.Constraint),
            ),
        ],
        "Currently scheduled jobs with each last-known constraint. One job may have multiple constraints; their sum is not a distinct-job total.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.Effects,
        "short",
        [
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.MarketActions, [
                    ...runtimeLabels,
                    label.Action,
                    label.Result,
                    label.DryRun,
                ]),
                legend(label.Action, label.Result, label.DryRun),
            ),
        ],
        "Process-lifetime place/cancel action outcomes. Success with dry_run=false means the action path completed; dry_run=true is simulated, not a marketplace write. Failure can include local tracking failure after an external effect, so it does not prove no offer was placed or cancelled.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.WorkProgress,
        "s",
        [
            target(
                timestampAge(
                    BIDDING_RUNTIME_METRIC_NAME.WorkLastProgress,
                    workLabels,
                ),
                `last start or finish / ${legend(label.Stage)}`,
            ),
            target(
                timestampAge(
                    BIDDING_RUNTIME_METRIC_NAME.WorkLastSuccess,
                    workLabels,
                ),
                `last success / ${legend(label.Stage)}`,
            ),
        ],
        "Last stage-boundary progress and last successful completion. Values persist when the stage is idle; compare with active work before diagnosing a stall. Failure updates progress but not success.",
    );

    layout.row("Bidding Runtime Health");
    layout.timeseries(
        "Runtime State",
        "short",
        [
            target(
                maxOf(BIDDING_RUNTIME_METRIC_NAME.RuntimeState, [
                    ...runtimeLabels,
                    label.RuntimeState,
                ]),
                legend(...runtimeLabels, label.RuntimeState),
            ),
        ],
        "A value of 1 identifies the current lifecycle state for each bidding bot and chain ID.",
    );
    layout.timeseries(
        "Time to Ready per Bot Start",
        "ms",
        [
            target(
                histogramLifetimeAverage(
                    BIDDING_RUNTIME_METRIC_NAME.RuntimeTimeToReady,
                    runtimeLabels,
                ),
                legend(...runtimeLabels),
            ),
        ],
        "Elapsed milliseconds from entering startBiddingRuntime until ready, after secret intake, configuration, policy agreement and metrics initialization. This is runtime bootstrap time, not total process startup time.",
    );
    layout.timeseries(
        "Bootstrap Phase Duration per Bot Start",
        "ms",
        [
            target(
                histogramLifetimeAverage(
                    BIDDING_RUNTIME_METRIC_NAME.RuntimeBootstrapPhaseDuration,
                    [...runtimeLabels, label.Phase, label.Result],
                ),
                legend(label.Phase, label.Result),
            ),
        ],
        "Current-process lifetime average milliseconds for each completed startup phase. Startup failures remain authoritative in structured logs because the metrics endpoint can close before Prometheus scrapes a failed phase.",
    );
    layout.timeseries(
        "Critical Path Latency p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.CommandClaimToStrategy,
                    0.95,
                    runtimeLabels,
                ),
                "command claimed to strategy",
            ),
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.JobRefreshQueueWait,
                    0.95,
                    runtimeLabels,
                ),
                "job refresh queue",
            ),
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.StreamEventAge,
                    0.95,
                    runtimeLabels,
                ),
                "inbound event age",
            ),
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.OpenSeaRateLimitWait,
                    0.95,
                    runtimeLabels,
                ),
                "OpenSea rate-limit wait",
            ),
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionQueueWait,
                    0.95,
                    runtimeLabels,
                ),
                "bid-book update queue",
            ),
        ],
        "Compares 95th-percentile milliseconds at the main handoff points so the largest end-to-end bottleneck is visible first.",
    );
    layout.timeseries(
        "Measurements Beyond Histogram Range",
        "percentunit",
        (
            Object.keys(
                BIDDING_RUNTIME_HISTOGRAM_BUCKETS,
            ) as HistogramMetricName[]
        ).map((name) =>
            target(
                `${histogramOverflowFraction(name, runtimeLabels)} > 0`,
                `${HISTOGRAM_MEASUREMENTS[name]} > ${BIDDING_RUNTIME_HISTOGRAM_BUCKETS[name].at(-1)!}`,
            ),
        ),
        "Percentage of completed observations above each measurement's largest finite bucket, by bot and chain. Only positive overflow is shown. A p95 outside its recorded range is omitted; this panel distinguishes overflow from absent observations. Long-operation and event-age ranges extend through 24 hours.",
    );
    layout.timeseries(
        "Active Pressure",
        "short",
        [
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.JobRefreshWaiting,
                    runtimeLabels,
                ),
                "job refresh waiting",
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.JobRefreshPending,
                    runtimeLabels,
                ),
                "job refresh pending",
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.CommandInFlight,
                    runtimeLabels,
                ),
                "commands in flight",
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.HotRefreshPendingSignals,
                    runtimeLabels,
                ),
                "inbound refresh signals pending",
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshPending,
                    runtimeLabels,
                ),
                "market offer sync pending",
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionPending,
                    runtimeLabels,
                ),
                "bid-book update pending",
            ),
        ],
        "Concurrent and queued work across the bidding pipeline. Sustained growth indicates work is arriving faster than it completes.",
    );
    layout.timeseries(
        BIDDING_DASHBOARD_PANEL.Failures,
        "short",
        [
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.CommandAttempts,
                    runtimeLabels,
                    [matcher(label.Result, "=", result.Failure)],
                ),
                "command attempt failures",
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.MarketActions,
                    runtimeLabels,
                    [matcher(label.Result, "=", result.Failure)],
                ),
                "market action failures",
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.OpenSeaOperations,
                    runtimeLabels,
                    [matcher(label.Result, "=", result.Failure)],
                ),
                "OpenSea failures",
            ),
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.StreamEvents, runtimeLabels, [
                    matcher(
                        label.Outcome,
                        "=",
                        OPEN_SEA_STREAM_EVENT_OUTCOME.NormalizationFailed,
                    ),
                ]),
                "inbound normalization failures",
            ),
            target(
                histogramCount(
                    BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshDuration,
                    [...runtimeLabels, label.Result],
                    [
                        matcher(
                            label.Result,
                            "=~",
                            snapshotRejectedResultPattern,
                        ),
                    ],
                ),
                `offer sync ${legend(label.Result)}`,
            ),
            target(
                histogramCount(
                    BIDDING_RUNTIME_METRIC_NAME.JobScanDuration,
                    [...runtimeLabels, label.Result],
                    [
                        matcher(
                            label.Result,
                            "=~",
                            [
                                BIDDER_SCAN_RESULT.Failure,
                                BIDDER_SCAN_RESULT.CompletedWithFailures,
                            ].join("|"),
                        ),
                    ],
                ),
                `job scan / ${legend(label.Result)}`,
            ),
            target(
                histogramCount(
                    BIDDING_RUNTIME_METRIC_NAME.JobRefreshDuration,
                    runtimeLabels,
                    [matcher(label.Result, "=", result.Failure)],
                ),
                "job refresh failures",
            ),
            target(
                histogramCount(
                    BIDDING_RUNTIME_METRIC_NAME.CommandReconciliationDuration,
                    [...runtimeLabels, label.Result],
                    [
                        matcher(
                            label.Result,
                            "=~",
                            [
                                BIDDING_COMMAND_RECONCILIATION_RESULT.Failure,
                                BIDDING_COMMAND_RECONCILIATION_RESULT.CompletedWithFailures,
                            ].join("|"),
                        ),
                    ],
                ),
                `command reconciliation / ${legend(label.Result)}`,
            ),
            target(
                histogramCount(
                    BIDDING_RUNTIME_METRIC_NAME.HotRefreshPassDuration,
                    runtimeLabels,
                    [matcher(label.Result, "=", result.Failure)],
                ),
                "inbound refresh pass failures",
            ),
            target(
                histogramCount(
                    BIDDING_RUNTIME_METRIC_NAME.StreamDispatchDuration,
                    runtimeLabels,
                    [matcher(label.Result, "=", result.Failure)],
                ),
                "inbound dispatch failures",
            ),
            target(
                histogramCount(
                    BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionDuration,
                    runtimeLabels,
                    [matcher(label.Result, "=", result.Failure)],
                ),
                "bid-book update failures",
            ),
        ],
        "Cumulative failures and rejected offer syncs for the current bidding bot process across commands, scans, refreshes, inbound normalization and dispatch, OpenSea, snapshots, and bid-book updates. Raw totals keep a first or singleton failure visible even when it happened before Prometheus obtained a baseline scrape.",
    );
    layout.timeseries(
        "Offer Sync Results and Queue Decisions",
        "ops",
        [
            target(
                histogramCountRate(
                    BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshDuration,
                    [...runtimeLabels, label.Result],
                ),
                `offer sync / ${legend(label.Result)}`,
            ),
            target(
                rateOf(BIDDING_RUNTIME_METRIC_NAME.HotRefreshSignals, [
                    ...runtimeLabels,
                    label.Lane,
                    label.Outcome,
                ]),
                legend(label.Lane, label.Outcome),
            ),
        ],
        "Final offer-sync results and inbound refresh queue decisions per second. Offer syncs remain split into complete, partial, and error results; dropped, evicted, and coalesced refresh outcomes remain visible without identifying individual NFTs.",
    );

    layout.row("Capacity and Job Scans");
    layout.timeseries(
        "Configured Concurrent Jobs and Queue Caps",
        "short",
        [
            target(
                maxOf(
                    BIDDING_RUNTIME_METRIC_NAME.RuntimeConfiguration,
                    [...runtimeLabels, label.Setting],
                    [
                        matcher(
                            label.Setting,
                            "=~",
                            [
                                BIDDING_RUNTIME_CONFIGURATION_SETTING.MaxConcurrentJobs,
                                BIDDING_RUNTIME_CONFIGURATION_SETTING.CommandBatchSize,
                                BIDDING_RUNTIME_CONFIGURATION_SETTING.HotRefreshBroadMaxPending,
                                BIDDING_RUNTIME_CONFIGURATION_SETTING.HotRefreshItemMaxPending,
                            ].join("|"),
                        ),
                    ],
                ),
                legend(label.Setting),
            ),
        ],
        "Live configured job concurrency, command batch size, and pending-signal caps for the selected bot and chain ID.",
    );
    layout.timeseries(
        "Configured Cadences",
        "ms",
        [
            target(
                maxOf(
                    BIDDING_RUNTIME_METRIC_NAME.RuntimeConfiguration,
                    [...runtimeLabels, label.Setting],
                    [
                        matcher(
                            label.Setting,
                            "=~",
                            [
                                BIDDING_RUNTIME_CONFIGURATION_SETTING.ScanIntervalMs,
                                BIDDING_RUNTIME_CONFIGURATION_SETTING.CommandPollMs,
                                BIDDING_RUNTIME_CONFIGURATION_SETTING.HealthPollMs,
                                BIDDING_RUNTIME_CONFIGURATION_SETTING.SnapshotPollMs,
                                BIDDING_RUNTIME_CONFIGURATION_SETTING.SnapshotTtlMs,
                                BIDDING_RUNTIME_CONFIGURATION_SETTING.HotRefreshBroadCooldownMs,
                                BIDDING_RUNTIME_CONFIGURATION_SETTING.HotRefreshItemCooldownMs,
                            ].join("|"),
                        ),
                    ],
                ),
                legend(label.Setting),
            ),
        ],
        "Configured milliseconds between scans, command polls, marketplace offer syncs, and inbound-refresh passes.",
    );
    layout.timeseries(
        "Bidding Jobs by Target Type",
        "short",
        [
            target(
                maxOf(BIDDING_RUNTIME_METRIC_NAME.Jobs, [
                    ...runtimeLabels,
                    label.TargetType,
                ]),
                legend(label.TargetType),
            ),
        ],
        "Current number of configured bidding jobs by bounded target type; it never identifies an individual job or collection.",
    );
    layout.timeseries(
        "Job Scan Duration p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.JobScanDuration,
                    0.95,
                    [...runtimeLabels, label.Result],
                ),
                legend(label.Result),
            ),
        ],
        "95th-percentile milliseconds to scan the dynamic bidding-job inventory.",
    );
    layout.timeseries(
        "Jobs Found in Latest Scan",
        "short",
        [
            target(
                maxOf(BIDDING_RUNTIME_METRIC_NAME.JobScanSize, runtimeLabels),
                legend(...runtimeLabels),
            ),
        ],
        "Number of bidding jobs captured when the current or most recent dynamic scan started.",
    );
    layout.row("Job Refresh and Market Actions");
    layout.timeseries(
        "Job Refresh Requests",
        "ops",
        [
            target(
                rateOf(BIDDING_RUNTIME_METRIC_NAME.JobRefreshRequests, [
                    ...runtimeLabels,
                    label.Trigger,
                    label.TargetType,
                    label.Outcome,
                ]),
                legend(label.Trigger, label.TargetType, label.Outcome),
            ),
        ],
        "Refresh requests per second by trigger, bounded target type, and whether work started, coalesced, or stopped.",
    );
    layout.timeseries(
        "Job Refresh Queue Wait p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.JobRefreshQueueWait,
                    0.95,
                    [...runtimeLabels, label.Trigger, label.TargetType],
                ),
                legend(label.Trigger, label.TargetType),
            ),
        ],
        "95th-percentile milliseconds a job refresh waits before it starts strategy work, by trigger and bounded target type.",
    );
    layout.timeseries(
        "Job Refresh Duration p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.JobRefreshDuration,
                    0.95,
                    [
                        ...runtimeLabels,
                        label.Trigger,
                        label.TargetType,
                        label.Result,
                    ],
                ),
                legend(label.Trigger, label.TargetType, label.Result),
            ),
        ],
        "95th-percentile end-to-end milliseconds for a job refresh, split by trigger, bounded target type, and result.",
    );
    layout.timeseries(
        "Job Refresh Concurrency",
        "short",
        [
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.JobRefreshActive,
                    runtimeLabels,
                ),
                "active",
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.JobRefreshWaiting,
                    runtimeLabels,
                ),
                "waiting",
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.JobRefreshPending,
                    runtimeLabels,
                ),
                "pending rerun",
            ),
        ],
        "Active job refreshes, requests waiting for a concurrency slot, and jobs with one coalesced rerun pending.",
    );
    layout.timeseries(
        "Market Actions",
        "ops",
        [
            target(
                rateOf(BIDDING_RUNTIME_METRIC_NAME.MarketActions, [
                    ...runtimeLabels,
                    label.Action,
                    label.TargetType,
                    label.Result,
                    label.DryRun,
                ]),
                legend(
                    label.Action,
                    label.TargetType,
                    label.Result,
                    label.DryRun,
                ),
            ),
        ],
        "Marketplace actions per second by action, bounded target type, result, and whether the bot was in dry-run mode.",
    );
    layout.timeseries(
        "Market Action Duration p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.MarketActionDuration,
                    0.95,
                    [
                        ...runtimeLabels,
                        label.Action,
                        label.TargetType,
                        label.Result,
                        label.DryRun,
                    ],
                ),
                legend(
                    label.Action,
                    label.TargetType,
                    label.Result,
                    label.DryRun,
                ),
            ),
        ],
        "95th-percentile milliseconds for marketplace actions by bounded target type, including failed and dry-run attempts.",
    );

    layout.row("Commands to Strategy");
    layout.timeseries(
        "Command Reconciliation Duration p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.CommandReconciliationDuration,
                    0.95,
                    [...runtimeLabels, label.Trigger, label.Result],
                ),
                legend(label.Trigger, label.Result),
            ),
        ],
        "95th-percentile milliseconds for one command-reconciliation pass, by poll or signal trigger and result.",
    );
    layout.timeseries(
        "Commands per Reconciliation p95",
        "short",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.CommandReconciliationBatchSize,
                    0.95,
                    [...runtimeLabels, label.Trigger, label.Result],
                ),
                legend(label.Trigger, label.Result),
            ),
        ],
        "95th-percentile number of bidding commands claimed per reconciliation pass.",
    );
    layout.timeseries(
        "Command Queue Wait p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.CommandQueueWait,
                    0.95,
                    [...runtimeLabels, label.CommandKind, label.Trigger],
                ),
                legend(label.CommandKind, label.Trigger),
            ),
        ],
        "95th-percentile milliseconds from command creation until it is claimed for processing.",
    );
    layout.timeseries(
        "Command Claimed to Strategy Start p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.CommandClaimToStrategy,
                    0.95,
                    [...runtimeLabels, label.CommandKind, label.Trigger],
                ),
                legend(label.CommandKind, label.Trigger),
            ),
        ],
        "95th-percentile milliseconds from a command being claimed until its job strategy actually starts.",
    );
    layout.timeseries(
        "Command Created to Strategy Start p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.CommandCreatedToStrategy,
                    0.95,
                    [...runtimeLabels, label.CommandKind, label.Trigger],
                ),
                legend(label.CommandKind, label.Trigger),
            ),
        ],
        "95th-percentile total milliseconds from command creation through queueing and strategy start.",
    );
    layout.timeseries(
        "Command Attempt Duration p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.CommandProcessingDuration,
                    0.95,
                    [...runtimeLabels, label.CommandKind, label.Result],
                ),
                legend(label.CommandKind, label.Result),
            ),
        ],
        "95th-percentile milliseconds for one command processing attempt, ending at completion, retry scheduling, or terminal failure.",
    );
    layout.timeseries(
        "Command Processing Attempts",
        "ops",
        [
            target(
                rateOf(BIDDING_RUNTIME_METRIC_NAME.CommandAttempts, [
                    ...runtimeLabels,
                    label.CommandKind,
                    label.Trigger,
                    label.Result,
                ]),
                legend(label.CommandKind, label.Trigger, label.Result),
            ),
        ],
        "Finished processing attempts per second by command kind, trigger, and attempt result. A command that fails twice before succeeding contributes two failures and one success. Failures include both scheduled retries and terminal failures; use structured command logs for the durable outcome.",
    );
    layout.timeseries(
        "Commands in Flight",
        "short",
        [
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.CommandInFlight,
                    runtimeLabels,
                ),
                legend(...runtimeLabels),
            ),
        ],
        "Commands currently being processed by the bidding runtime.",
    );

    layout.row("Inbound Marketplace Events");
    layout.timeseries(
        "Inbound Events",
        "ops",
        [
            target(
                rateOf(BIDDING_RUNTIME_METRIC_NAME.StreamEvents, [
                    ...runtimeLabels,
                    label.EventType,
                    label.EventScope,
                    label.Outcome,
                ]),
                legend(label.EventType, label.EventScope, label.Outcome),
            ),
        ],
        "Inbound OpenSea events per second by bounded event type, scope, and normalization outcome.",
    );
    layout.timeseries(
        "Inbound Event Age p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.StreamEventAge,
                    0.95,
                    [...runtimeLabels, label.EventType, label.EventScope],
                ),
                legend(label.EventType, label.EventScope),
            ),
        ],
        "95th-percentile milliseconds between an event's marketplace timestamp and local receipt.",
    );
    layout.timeseries(
        "Inbound Dispatch Duration p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.StreamDispatchDuration,
                    0.95,
                    [
                        ...runtimeLabels,
                        label.EventType,
                        label.EventScope,
                        label.Result,
                    ],
                ),
                legend(label.EventType, label.EventScope, label.Result),
            ),
        ],
        "95th-percentile milliseconds to dispatch one normalized event into bidding refresh work.",
    );
    layout.timeseries(
        "Inbound Dispatches Active",
        "short",
        [
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.StreamDispatchActive,
                    runtimeLabels,
                ),
                legend(...runtimeLabels),
            ),
        ],
        "Inbound event dispatches currently executing. Sustained growth indicates event handling is monopolizing runtime resources.",
    );
    layout.timeseries(
        "Refresh Signal Decisions",
        "ops",
        [
            target(
                rateOf(BIDDING_RUNTIME_METRIC_NAME.HotRefreshSignals, [
                    ...runtimeLabels,
                    label.Lane,
                    label.Outcome,
                ]),
                legend(label.Lane, label.Outcome),
            ),
        ],
        "Inbound refresh signals per second by lane and queue decision, including coalesced, dropped, and evicted work.",
    );
    layout.timeseries(
        "Pending Events and Signals",
        "short",
        [
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.HotRefreshPendingEvents, [
                    ...runtimeLabels,
                    label.Lane,
                ]),
                `${legend(label.Lane)} / events`,
            ),
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.HotRefreshPendingSignals, [
                    ...runtimeLabels,
                    label.Lane,
                ]),
                `${legend(label.Lane)} / signals`,
            ),
        ],
        "Pending marketplace events and refresh signals by bounded refresh lane.",
    );
    layout.timeseries(
        "Hot-Refresh Lane Pressure",
        "short",
        [
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.HotRefreshActiveLanes, [
                    ...runtimeLabels,
                    label.Lane,
                ]),
                `${legend(label.Lane)} / active`,
            ),
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.HotRefreshKnownLanes, [
                    ...runtimeLabels,
                    label.Lane,
                ]),
                `${legend(label.Lane)} / known`,
            ),
        ],
        "Active versus known refresh lanes, including retained cooldown identity. Per lane kind, known identity is bounded by twice that kind's max-pending setting plus the shared max-concurrent-jobs setting.",
    );
    layout.timeseries(
        "Hot-Refresh Queue Wait p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.HotRefreshQueueWait,
                    0.95,
                    [...runtimeLabels, label.Lane],
                ),
                legend(label.Lane),
            ),
        ],
        "95th-percentile milliseconds from the first pending signal until its refresh pass starts.",
    );
    layout.timeseries(
        "Hot-Refresh Pass Duration p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.HotRefreshPassDuration,
                    0.95,
                    [...runtimeLabels, label.Lane, label.Result],
                ),
                legend(label.Lane, label.Result),
            ),
        ],
        "95th-percentile milliseconds for one inbound refresh pass by lane and result.",
    );
    layout.timeseries(
        "Events and Signals per Refresh Pass p95",
        "short",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.HotRefreshPassEvents,
                    0.95,
                    [...runtimeLabels, label.Lane],
                ),
                `${legend(label.Lane)} / events`,
            ),
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.HotRefreshPassSignals,
                    0.95,
                    [...runtimeLabels, label.Lane],
                ),
                `${legend(label.Lane)} / signals`,
            ),
        ],
        "95th-percentile number of marketplace events and coalesced signals handled by one refresh pass.",
    );

    layout.row("OpenSea API and Rate Limits");
    layout.timeseries(
        "OpenSea Operations",
        "ops",
        [
            target(
                rateOf(BIDDING_RUNTIME_METRIC_NAME.OpenSeaOperations, [
                    ...runtimeLabels,
                    label.Lane,
                    label.Operation,
                    label.Priority,
                    label.Result,
                ]),
                legend(
                    label.Lane,
                    label.Operation,
                    label.Priority,
                    label.Result,
                ),
            ),
        ],
        "OpenSea calls per second by bounded lane, operation, request priority, and result.",
    );
    layout.timeseries(
        "OpenSea Operation Duration p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.OpenSeaOperationDuration,
                    0.95,
                    [
                        ...runtimeLabels,
                        label.Lane,
                        label.Operation,
                        label.Priority,
                        label.Result,
                    ],
                ),
                legend(
                    label.Lane,
                    label.Operation,
                    label.Priority,
                    label.Result,
                ),
            ),
        ],
        "95th-percentile milliseconds spent inside the OpenSea call itself, excluding the local rate-limit wait.",
    );
    layout.timeseries(
        "OpenSea Retries",
        "ops",
        [
            target(
                rateOf(BIDDING_RUNTIME_METRIC_NAME.OpenSeaRetries, [
                    ...runtimeLabels,
                    label.Lane,
                    label.Operation,
                    label.Priority,
                ]),
                legend(label.Lane, label.Operation, label.Priority),
            ),
        ],
        "Retry attempts per second by OpenSea lane, operation, and request priority.",
    );
    layout.timeseries(
        "OpenSea Rate-Limit Wait p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.OpenSeaRateLimitWait,
                    0.95,
                    [
                        ...runtimeLabels,
                        label.Lane,
                        label.Priority,
                        label.Outcome,
                    ],
                ),
                legend(label.Lane, label.Priority, label.Outcome),
            ),
        ],
        "95th-percentile milliseconds spent waiting for a local OpenSea rate-limit token, split by request priority and immediate versus queued outcome.",
    );
    layout.timeseries(
        "OpenSea Rate-Limit Queue Depth",
        "short",
        [
            target(
                sumOf(BIDDING_RUNTIME_METRIC_NAME.OpenSeaRateLimitQueueDepth, [
                    ...runtimeLabels,
                    label.Lane,
                ]),
                legend(label.Lane),
            ),
        ],
        "Requests currently queued for a local OpenSea rate-limit token by lane.",
    );

    layout.row("Marketplace Offer Sync and Bid-Book Update");
    layout.timeseries(
        "Offer Sync Requests",
        "ops",
        [
            target(
                rateOf(BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshRequests, [
                    ...runtimeLabels,
                    label.Outcome,
                ]),
                legend(label.Outcome),
            ),
        ],
        "Marketplace offer-sync requests per second by whether work started, joined existing work, or was skipped.",
    );
    layout.timeseries(
        "Offer Sync Results",
        "ops",
        [
            target(
                histogramCountRate(
                    BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshDuration,
                    [...runtimeLabels, label.Result],
                ),
                legend(label.Result),
            ),
        ],
        "Finished marketplace offer syncs per second, split into complete, partial, and error results.",
    );
    layout.timeseries(
        "Offer Sync Duration p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshDuration,
                    0.95,
                    [...runtimeLabels, label.Result],
                ),
                legend(label.Result),
            ),
        ],
        "95th-percentile end-to-end milliseconds to synchronize a collection's marketplace offers, split into complete, partial, and error results.",
    );
    layout.timeseries(
        "Pages and Offers per Sync p95",
        "short",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshPages,
                    0.95,
                    [...runtimeLabels, label.Result],
                ),
                `${legend(label.Result)} / pages`,
            ),
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshOffers,
                    0.95,
                    [...runtimeLabels, label.Result],
                ),
                `${legend(label.Result)} / offers`,
            ),
        ],
        "95th-percentile marketplace pages and offers processed in one offer sync, with complete, partial, and error results shown separately.",
    );
    layout.timeseries(
        "Offer Sync Pressure",
        "short",
        [
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshInFlight,
                    runtimeLabels,
                ),
                "in flight",
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.SnapshotRefreshPending,
                    runtimeLabels,
                ),
                "pending",
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.SnapshotWatchedCollections,
                    runtimeLabels,
                ),
                "watched collections",
            ),
        ],
        "Offer syncs currently running or pending and the aggregate number of collections being watched.",
    );
    layout.timeseries(
        "Bid-Book Update Requests",
        "ops",
        [
            target(
                rateOf(BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionRequests, [
                    ...runtimeLabels,
                    label.Outcome,
                ]),
                legend(label.Outcome),
            ),
        ],
        "Bid-book update requests per second, including work that starts immediately or is coalesced behind an active update.",
    );
    layout.timeseries(
        "Bid-Book Update Queue Wait p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionQueueWait,
                    0.95,
                    [...runtimeLabels, label.Result],
                ),
                legend(label.Result),
            ),
        ],
        "95th-percentile milliseconds between request admission and the start of any bid-book update pass, including immediate and coalesced work.",
    );
    layout.timeseries(
        "Bid-Book Update Duration p95",
        "ms",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionDuration,
                    0.95,
                    [...runtimeLabels, label.Result],
                ),
                legend(label.Result),
            ),
        ],
        "95th-percentile milliseconds to rebuild the local bid-book view from synchronized marketplace offers.",
    );
    layout.timeseries(
        "Rows Written per Bid-Book Update p95",
        "short",
        [
            target(
                histogramPercentile(
                    BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionRows,
                    0.95,
                    [...runtimeLabels, label.Result],
                ),
                legend(label.Result),
            ),
        ],
        "95th-percentile number of local bid-book entries written in one update.",
    );
    layout.timeseries(
        "Bid-Book Update Pressure",
        "short",
        [
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionActive,
                    runtimeLabels,
                ),
                "active",
            ),
            target(
                sumOf(
                    BIDDING_RUNTIME_METRIC_NAME.BidBookProjectionPending,
                    runtimeLabels,
                ),
                "pending rerun",
            ),
        ],
        "Bid-book updates currently running and coalesced reruns waiting behind them.",
    );

    layout.row("Process Resources");
    layout.timeseries(
        "Bidding Bot Uptime",
        "s",
        [
            target(
                `time() - ${PROM_CLIENT_METRIC_NAME.ProcessStartTime}${scoped()}`,
                legend(...runtimeLabels),
            ),
        ],
        "Seconds since each selected bidding bot process started.",
    );
    layout.timeseries(
        "Process RSS",
        "bytes",
        [
            target(
                `${PROM_CLIENT_METRIC_NAME.ProcessResidentMemory}${scoped()}`,
                legend(...runtimeLabels),
            ),
        ],
        "Resident memory used by each selected bidding bot process in bytes.",
    );
    layout.timeseries(
        "Process CPU Usage",
        "percentunit",
        [
            target(
                `rate(${PROM_CLIENT_METRIC_NAME.ProcessCpu}${scoped()}[$__rate_interval])`,
                legend(...runtimeLabels),
            ),
        ],
        "CPU seconds consumed per wall-clock second by each selected bidding bot process.",
    );
    layout.timeseries(
        "Event-Loop Delay p99",
        "s",
        [
            target(
                `${PROM_CLIENT_METRIC_NAME.EventLoopLagP99}${scoped()}`,
                legend(...runtimeLabels),
            ),
        ],
        "99th-percentile event-loop delay in seconds. Sustained increases indicate the process cannot promptly schedule more work.",
    );

    return {
        annotations: {
            list: [
                {
                    builtIn: 1,
                    datasource: { type: "grafana", uid: "-- Grafana --" },
                    enable: true,
                    hide: true,
                    iconColor: "rgba(0, 211, 255, 1)",
                    name: "Annotations & Alerts",
                    type: "dashboard",
                },
            ],
        },
        description:
            "End-to-end bidding runtime timing, queue pressure, inbound marketplace events, OpenSea calls, and process resources. If every panel is empty, enable the bidding metrics endpoint, restart the bidding bot, and confirm the Prometheus target is healthy.",
        editable: true,
        fiscalYearStartMonth: 0,
        graphTooltip: 1,
        id: null,
        links: [],
        liveNow: false,
        panels: layout.panels,
        refresh: "10s",
        schemaVersion: 39,
        style: "dark",
        tags: ["artgod", "bidding", "runtime", "metrics"],
        templating: {
            list: [
                dashboardVariable(
                    DASHBOARD_VARIABLE.Worker,
                    metricName(BIDDING_RUNTIME_METRIC_NAME.RuntimeState),
                ),
                dashboardVariable(
                    DASHBOARD_VARIABLE.ChainId,
                    metricName(BIDDING_RUNTIME_METRIC_NAME.RuntimeState),
                ),
            ],
        },
        time: { from: "now-1h", to: "now" },
        timepicker: {},
        timezone: "",
        title: DASHBOARD_TITLE,
        uid: DASHBOARD_UID,
        version: 1,
        weekStart: "",
    };
}

function dashboardVariable(variableName: string, sourceMetric: string) {
    const query = `label_values(${sourceMetric}, ${variableName})`;
    return {
        allValue: ".*",
        current: {
            selected: true,
            text: ["All"],
            value: ["$__all"],
        },
        datasource: PROMETHEUS_DATASOURCE,
        definition: query,
        hide: 0,
        includeAll: true,
        label: variableName,
        multi: true,
        name: variableName,
        options: [],
        query,
        refresh: 2,
        sort: 1,
        type: "query",
    };
}

// Reject unknown metrics, identity-bearing labels, and ambiguous multi-runtime legends.
export function validateDashboard(dashboard: Record<string, unknown>): void {
    const rendered = JSON.stringify(dashboard);
    const allowedBiddingMetrics = new Set(
        Object.values(BIDDING_RUNTIME_METRIC_NAME).flatMap((name) => {
            const base = metricName(name);
            return [base, `${base}_bucket`, `${base}_count`, `${base}_sum`];
        }),
    );

    for (const referencedMetric of rendered.match(
        BIDDING_METRIC_REFERENCE_PATTERN,
    ) ?? []) {
        if (!allowedBiddingMetrics.has(referencedMetric)) {
            throw new Error(
                `Dashboard references an unknown bidding metric: ${referencedMetric}`,
            );
        }
    }

    for (const forbiddenLabel of BIDDING_RUNTIME_FORBIDDEN_HIGH_CARDINALITY_LABELS) {
        const labelUse = new RegExp(
            `(?:[,{(]|\\{\\{)\\s*${forbiddenLabel}\\s*(?:=~|!~|!=|=|,|\\)|\\}\\})`,
        );
        if (labelUse.test(rendered)) {
            throw new Error(
                `Dashboard must not query or group by high-cardinality label: ${forbiddenLabel}`,
            );
        }
    }

    const panels = dashboard.panels;
    if (!Array.isArray(panels)) {
        throw new Error("Dashboard must contain panels");
    }
    for (const panel of panels) {
        if (!panel || typeof panel !== "object" || !("targets" in panel)) {
            continue;
        }
        const targets = panel.targets;
        if (!Array.isArray(targets)) {
            continue;
        }
        for (const dashboardTarget of targets) {
            if (
                !dashboardTarget ||
                typeof dashboardTarget !== "object" ||
                !("legendFormat" in dashboardTarget) ||
                typeof dashboardTarget.legendFormat !== "string"
            ) {
                throw new Error("Every dashboard target must define a legend");
            }
            for (const runtimeLabel of [
                DASHBOARD_VARIABLE.Worker,
                DASHBOARD_VARIABLE.ChainId,
            ]) {
                if (
                    !dashboardTarget.legendFormat.includes(
                        `{{${runtimeLabel}}}`,
                    )
                ) {
                    throw new Error(
                        `Dashboard target legend is missing ${runtimeLabel}`,
                    );
                }
            }
        }
    }
}

function escapeRegularExpression(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main(): Promise<void> {
    const dashboard = buildDashboard();
    validateDashboard(dashboard);
    for (const [destination, value] of [
        [DASHBOARD_OUTPUT, dashboard],
        [ALERT_OUTPUT, buildBiddingAlertRules()],
    ] as const) {
        const output = await format(JSON.stringify(value), {
            parser: "json",
            tabWidth: 4,
        });
        if (process.argv.includes("--check")) {
            const current = await readFile(destination, "utf8").catch(() => "");
            if (current !== output)
                throw new Error(
                    `Bidding observability artifact ${path.basename(destination)} is stale. Run yarn observability:bidding-dashboard:generate.`,
                );
        } else {
            await mkdir(path.dirname(destination), { recursive: true });
            await writeFile(destination, output, "utf8");
        }
        console.log(
            `${process.argv.includes("--check") ? "Verified" : "Generated"} ${path.relative(process.cwd(), destination)}.`,
        );
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    await main();
}
