import { describe, expect, it } from "vitest";
import {
    GAP_FILL_MODE,
    RpcBudgetScheduler,
} from "@artgod/shared/evm/rpc-budget";
import { RPC_RATE_LIMIT_MODE } from "@artgod/shared/evm/rpc-resilience";
import { SYNC_WORK_CLASS as CLASS } from "@artgod/shared/types/sync-work-class";
import { RPC_OBSERVABILITY_LABEL as LABEL } from "@artgod/shared/observability/rpc";
import {
    RpcBudgetMetrics,
    RPC_BUDGET_METRIC_LABEL,
} from "../src/infra/rpc/budget-metrics.js";
import { processingTelemetry } from "./helpers/processing-observability.js";

describe("allocation owner metrics", () => {
    it("exports current main/background waiters, leases and wait ages, then clears them after expiry", async () => {
        let now = 0;
        const total = {
            mode: RPC_RATE_LIMIT_MODE.Limited,
            requestsPerSecond: 5,
            burst: 1,
        };
        const gap = {
            mode: GAP_FILL_MODE.Limited,
            requestsPerSecond: 1.5,
            maxInFlight: 3,
        };
        const telemetry = await processingTelemetry();
        const observer = new RpcBudgetMetrics(telemetry.metrics, total, gap);
        const budget = new RpcBudgetScheduler(
            [{ key: "endpoint", limit: total }],
            gap,
            1000,
            () => now,
        );
        const waiting: Promise<unknown>[] = [];
        try {
            await budget.acquire({
                id: "active",
                endpointKey: "endpoint",
                workClass: CLASS.Main,
            });
            waiting.push(
                budget
                    .acquire({
                        id: "gap-wait",
                        endpointKey: "endpoint",
                        workClass: CLASS.GapRepair,
                    })
                    .catch(() => {}),
            );
            now = 100;
            waiting.push(
                budget
                    .acquire({
                        id: "main-wait",
                        endpointKey: "endpoint",
                        workClass: CLASS.Main,
                    })
                    .catch(() => {}),
            );
            now = 150;
            observer.report(budget.snapshot());
            const main = { [LABEL.WorkClass]: CLASS.Main },
                background = { [LABEL.WorkClass]: CLASS.GapRepair };
            expect(
                await telemetry.value("rpc_budget_waiting_requests", main),
            ).toBe(1);
            expect(
                await telemetry.value(
                    "rpc_budget_waiting_requests",
                    background,
                ),
            ).toBe(1);
            expect(
                await telemetry.value("rpc_budget_in_flight_requests", main),
            ).toBe(1);
            expect(
                await telemetry.value(
                    "rpc_budget_in_flight_requests",
                    background,
                ),
            ).toBe(0);
            expect(
                await telemetry.value("rpc_budget_oldest_wait_seconds", main),
            ).toBe(0.05);
            expect(
                await telemetry.value(
                    "rpc_budget_oldest_wait_seconds",
                    background,
                ),
            ).toBe(0.15);
            expect(
                await telemetry.value(
                    "rpc_budget_total_rate_limit_requests_per_second",
                ),
            ).toBe(5);
            expect(
                await telemetry.value(
                    "rpc_budget_gap_rate_limit_requests_per_second",
                ),
            ).toBe(1.5);
            expect(
                await telemetry.value("rpc_budget_gap_in_flight_limit"),
            ).toBe(3);
            now = 31_000;
            observer.report(budget.snapshot());
            for (const labels of [main, background]) {
                expect(
                    await telemetry.value(
                        "rpc_budget_waiting_requests",
                        labels,
                    ),
                ).toBe(0);
                expect(
                    await telemetry.value(
                        "rpc_budget_in_flight_requests",
                        labels,
                    ),
                ).toBe(0);
                expect(
                    await telemetry.value(
                        "rpc_budget_oldest_wait_seconds",
                        labels,
                    ),
                ).toBe(0);
            }
        } finally {
            budget.stop();
            await Promise.all(waiting);
        }
    });

    it.each([GAP_FILL_MODE.Disabled, GAP_FILL_MODE.Unlimited])(
        "exports %s mode without inventing numeric ceilings",
        async (mode) => {
            const telemetry = await processingTelemetry();
            new RpcBudgetMetrics(
                telemetry.metrics,
                { mode: RPC_RATE_LIMIT_MODE.Unlimited },
                { mode },
            );
            expect(
                await telemetry.value("rpc_budget_policy", {
                    [RPC_BUDGET_METRIC_LABEL.OverallMode]:
                        RPC_RATE_LIMIT_MODE.Unlimited,
                    [RPC_BUDGET_METRIC_LABEL.GapMode]: mode,
                }),
            ).toBe(1);
            const scrape = await telemetry.metrics.metricsText();
            expect(scrape).not.toContain(
                "rpc_budget_total_rate_limit_requests_per_second",
            );
            expect(scrape).not.toContain(
                "rpc_budget_gap_rate_limit_requests_per_second",
            );
            expect(scrape).not.toContain("rpc_budget_gap_in_flight_limit");
        },
    );
});
