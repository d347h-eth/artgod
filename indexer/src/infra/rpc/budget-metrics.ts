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
import { SYNC_WORK_CLASS } from "@artgod/shared/types/sync-work-class";
import { observeBestEffort } from "../../application/processing-observability.js";

export const RPC_BUDGET_METRIC = {
    Policy: "rpc.budget.policy",
    TotalRateLimit: "rpc.budget.total_rate_limit_requests_per_second",
    GapRateLimit: "rpc.budget.gap_rate_limit_requests_per_second",
    GapConcurrencyLimit: "rpc.budget.gap_in_flight_limit",
    Waiting: "rpc.budget.waiting_requests",
    InFlight: "rpc.budget.in_flight_requests",
    OldestWait: "rpc.budget.oldest_wait_seconds",
} as const;
export const RPC_BUDGET_METRIC_LABEL = {
    OverallMode: "overall_mode",
    GapMode: "gap_mode",
} as const;
export const RPC_BUDGET_METRIC_POLICY = { SampleIntervalMs: 1000 } as const;

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
