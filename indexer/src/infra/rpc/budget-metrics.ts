import type { Metrics } from "@artgod/shared/observability/metrics";
import { RPC_OBSERVABILITY_LABEL } from "@artgod/shared/observability/rpc";
import {
    GAP_FILL_MODE,
    type RpcGapAllocation,
    type RpcBudgetSnapshot,
} from "@artgod/shared/evm/rpc-budget";
import {
    RPC_RATE_LIMIT_MODE,
    type RpcRateLimiterConfig,
} from "@artgod/shared/evm/rpc-resilience";
import {
    SYNC_WORK_CLASS,
    type SyncWorkClass,
} from "@artgod/shared/types/sync-work-class";
import { observeBestEffort } from "../../application/processing-observability.js";

export const RPC_BUDGET_METRIC = {
    Policy: "rpc.budget.policy",
    TotalRateLimit: "rpc.budget.total_rate_limit_requests_per_second",
    GapRateLimit: "rpc.budget.gap_rate_limit_requests_per_second",
    GapConcurrencyLimit: "rpc.budget.gap_in_flight_limit",
    Waiting: "rpc.budget.waiting_requests",
    InFlight: "rpc.budget.in_flight_requests",
    OldestWait: "rpc.budget.oldest_wait_seconds",
    TransportEvents: "rpc.budget.transport_events",
    RoundTrip: "rpc.budget.round_trip_seconds",
    Probes: "rpc.budget.probes",
    LastProbeSuccess: "rpc.budget.last_probe_success_timestamp_seconds",
} as const;
export const RPC_BUDGET_METRIC_LABEL = {
    OverallMode: "overall_mode",
    GapMode: "gap_mode",
    Event: "event",
    Target: "target",
    Result: "result",
} as const;
export const RPC_BUDGET_METRIC_POLICY = {
    SampleIntervalMs: 1000,
    ProbeIntervalMs: 5000,
    ProbeTimeoutMs: 1000,
} as const;
export const RPC_BUDGET_PROBE_TARGET = {
    Broker: "broker",
    Coordinator: "coordinator",
} as const;
export type RpcBudgetProbeTarget =
    (typeof RPC_BUDGET_PROBE_TARGET)[keyof typeof RPC_BUDGET_PROBE_TARGET];
export const RPC_BUDGET_PROBE_RESULT = {
    Success: "success",
    Timeout: "timeout",
    Unavailable: "unavailable",
    Error: "error",
} as const;
export type RpcBudgetProbeResult =
    (typeof RPC_BUDGET_PROBE_RESULT)[keyof typeof RPC_BUDGET_PROBE_RESULT];
export const RPC_BUDGET_TRANSPORT_EVENT = {
    Granted: "permit_granted",
    WaitTimeout: "wait_timeout",
    OwnerUnavailable: "owner_unavailable",
    MainFallback: "main_fallback",
    RequestError: "request_error",
} as const;
type RpcBudgetTransportEvent =
    (typeof RPC_BUDGET_TRANSPORT_EVENT)[keyof typeof RPC_BUDGET_TRANSPORT_EVENT];
const ROUND_TRIP_BUCKETS_SECONDS = [
    0.0001, 0.0005, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 5,
];

/** Per-client coordination health; probe duration excludes allocation waits. */
export class RpcBudgetTransportMetrics {
    constructor(private readonly metrics: Metrics) {}

    event(event: RpcBudgetTransportEvent, workClass: SyncWorkClass): void {
        observeBestEffort(() =>
            this.metrics.increment(RPC_BUDGET_METRIC.TransportEvents, 1, {
                [RPC_BUDGET_METRIC_LABEL.Event]: event,
                [RPC_OBSERVABILITY_LABEL.WorkClass]: workClass,
            }),
        );
    }

    probeCompleted(input: {
        target: RpcBudgetProbeTarget;
        result: RpcBudgetProbeResult;
        durationMs: number;
        completedAtMs: number;
    }): void {
        const labels = {
            [RPC_BUDGET_METRIC_LABEL.Target]: input.target,
            [RPC_BUDGET_METRIC_LABEL.Result]: input.result,
        };
        observeBestEffort(() => {
            this.metrics.increment(RPC_BUDGET_METRIC.Probes, 1, labels);
            this.metrics.histogram(
                RPC_BUDGET_METRIC.RoundTrip,
                input.durationMs / 1000,
                labels,
                { buckets: ROUND_TRIP_BUCKETS_SECONDS },
            );
            if (input.result === RPC_BUDGET_PROBE_RESULT.Success)
                this.metrics.gauge(
                    RPC_BUDGET_METRIC.LastProbeSuccess,
                    input.completedAtMs / 1000,
                    { [RPC_BUDGET_METRIC_LABEL.Target]: input.target },
                );
        });
    }
}

/** Only the chain's allocation owner exports these aggregate gauges.
 * Rate ceilings are per endpoint; concurrency and request counts cover all endpoints.
 * An inactive ceiling is absent, rather than encoding unlimited as a numeric value. */
export class RpcBudgetMetrics {
    constructor(
        private readonly metrics: Metrics,
        total: RpcRateLimiterConfig,
        gap: RpcGapAllocation,
    ) {
        observeBestEffort(() => {
            metrics.gauge(RPC_BUDGET_METRIC.Policy, 1, {
                [RPC_BUDGET_METRIC_LABEL.OverallMode]: total.mode,
                [RPC_BUDGET_METRIC_LABEL.GapMode]: gap.mode,
            });
            if (total.mode === RPC_RATE_LIMIT_MODE.Limited)
                metrics.gauge(
                    RPC_BUDGET_METRIC.TotalRateLimit,
                    total.requestsPerSecond,
                );
            if (gap.mode === GAP_FILL_MODE.Limited) {
                metrics.gauge(
                    RPC_BUDGET_METRIC.GapRateLimit,
                    gap.requestsPerSecond,
                );
                metrics.gauge(
                    RPC_BUDGET_METRIC.GapConcurrencyLimit,
                    gap.maxInFlight,
                );
            }
        });
    }

    report(snapshot: RpcBudgetSnapshot): void {
        for (const [workClass, waiting, inFlight, ageMs] of [
            [
                SYNC_WORK_CLASS.Main,
                snapshot.mainWaiting,
                snapshot.mainInFlight,
                snapshot.mainOldestWaitMs,
            ],
            [
                SYNC_WORK_CLASS.GapRepair,
                snapshot.gapWaiting,
                snapshot.gapInFlight,
                snapshot.gapOldestWaitMs,
            ],
        ] as const) {
            const labels = { [RPC_OBSERVABILITY_LABEL.WorkClass]: workClass };
            observeBestEffort(() => {
                this.metrics.gauge(RPC_BUDGET_METRIC.Waiting, waiting, labels);
                this.metrics.gauge(
                    RPC_BUDGET_METRIC.InFlight,
                    inFlight,
                    labels,
                );
                this.metrics.gauge(
                    RPC_BUDGET_METRIC.OldestWait,
                    ageMs / 1000,
                    labels,
                );
            });
        }
    }
}
