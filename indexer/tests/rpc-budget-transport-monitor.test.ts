import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "nats";
import {
    RPC_BUDGET_METRIC_POLICY as POLICY,
    RPC_BUDGET_PROBE_RESULT as RESULT,
    RPC_BUDGET_PROBE_TARGET as TARGET,
    RPC_BUDGET_METRIC_LABEL as LABEL,
    RPC_BUDGET_TRANSPORT_EVENT as EVENT,
    RpcBudgetTransportMetrics,
} from "../src/infra/rpc/budget-metrics.js";
import { RpcBudgetTransportMonitor } from "../src/infra/rpc/budget-transport-monitor.js";
import { SYNC_WORK_CLASS } from "@artgod/shared/types/sync-work-class";
import { processingTelemetry } from "./helpers/processing-observability.js";

describe("RPC coordination health samples", () => {
    const monitors: RpcBudgetTransportMonitor[] = [];
    afterEach(() => {
        for (const monitor of monitors.splice(0)) monitor.stop();
        vi.useRealTimers();
    });
    function clock() {
        vi.useFakeTimers({
            toFake: [
                "Date",
                "performance",
                "setTimeout",
                "clearTimeout",
                "setInterval",
                "clearInterval",
            ],
        });
        vi.setSystemTime(1_000_000);
    }
    function monitor(
        observer: RpcBudgetTransportMetrics,
        probes: ConstructorParameters<typeof RpcBudgetTransportMonitor>[1],
    ) {
        const result = new RpcBudgetTransportMonitor(observer, probes);
        monitors.push(result);
        result.start();
        return result;
    }
    function labels(
        target: (typeof TARGET)[keyof typeof TARGET],
        result: (typeof RESULT)[keyof typeof RESULT],
    ) {
        return { [LABEL.Target]: target, [LABEL.Result]: result };
    }
    it("measures separate broker/owner latency with sub-millisecond buckets and last-success times", async () => {
        const telemetry = await processingTelemetry();
        clock();
        const broker = vi.fn(
                () => new Promise<void>((resolve) => setTimeout(resolve, 2)),
            ),
            coordinator = vi.fn(
                () => new Promise<void>((resolve) => setTimeout(resolve, 12)),
            );
        monitor(new RpcBudgetTransportMetrics(telemetry.metrics), {
            [TARGET.Broker]: broker,
            [TARGET.Coordinator]: coordinator,
        });
        await vi.advanceTimersByTimeAsync(POLICY.ProbeIntervalMs + 20);
        expect(broker).toHaveBeenCalledTimes(1);
        expect(coordinator).toHaveBeenCalledTimes(1);
        expect(
            await telemetry.value(
                "rpc_budget_round_trip_seconds_sum",
                labels(TARGET.Broker, RESULT.Success),
            ),
        ).toBeCloseTo(0.002);
        expect(
            await telemetry.value(
                "rpc_budget_round_trip_seconds_sum",
                labels(TARGET.Coordinator, RESULT.Success),
            ),
        ).toBeCloseTo(0.012);
        expect(
            await telemetry.value(
                "rpc_budget_probes_total",
                labels(TARGET.Coordinator, RESULT.Success),
            ),
        ).toBe(1);
        expect(
            await telemetry.value(
                "rpc_budget_last_probe_success_timestamp_seconds",
                { [LABEL.Target]: TARGET.Coordinator },
            ),
        ).toBeCloseTo(1005.012);
        expect(await telemetry.metrics.metricsText()).toContain('le="0.0001"');
    });
    it("reports a stalled native PING once and does not accumulate probes while other samples continue", async () => {
        const telemetry = await processingTelemetry();
        clock();
        const pending = Promise.withResolvers<void>();
        const broker = vi.fn(() => pending.promise),
            coordinator = vi.fn(async () => {});
        monitor(new RpcBudgetTransportMetrics(telemetry.metrics), {
            [TARGET.Broker]: broker,
            [TARGET.Coordinator]: coordinator,
        });
        await vi.advanceTimersByTimeAsync(6 * POLICY.ProbeIntervalMs);
        expect(broker).toHaveBeenCalledTimes(1);
        expect(coordinator).toHaveBeenCalledTimes(6);
        expect(
            await telemetry.value(
                "rpc_budget_probes_total",
                labels(TARGET.Broker, RESULT.Timeout),
            ),
        ).toBe(1);
        pending.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await expect(
            telemetry.value(
                "rpc_budget_probes_total",
                labels(TARGET.Broker, RESULT.Success),
            ),
        ).rejects.toThrow("found 0");
        await vi.advanceTimersByTimeAsync(POLICY.ProbeIntervalMs);
        expect(broker).toHaveBeenCalledTimes(2);
        expect(
            await telemetry.value(
                "rpc_budget_probes_total",
                labels(TARGET.Broker, RESULT.Success),
            ),
        ).toBe(1);
    });
    it.each([
        [ErrorCode.NoResponders, RESULT.Unavailable],
        [ErrorCode.Timeout, RESULT.Timeout],
        [ErrorCode.Disconnect, RESULT.Error],
    ])(
        "classifies %s without treating it as a successful latency sample",
        async (code, result) => {
            const telemetry = await processingTelemetry();
            clock();
            monitor(new RpcBudgetTransportMetrics(telemetry.metrics), {
                [TARGET.Broker]: async () => {},
                [TARGET.Coordinator]: async () => {
                    throw { code };
                },
            });
            await vi.advanceTimersByTimeAsync(POLICY.ProbeIntervalMs);
            expect(
                await telemetry.value(
                    "rpc_budget_probes_total",
                    labels(TARGET.Coordinator, result),
                ),
            ).toBe(1);
            await expect(
                telemetry.value(
                    "rpc_budget_last_probe_success_timestamp_seconds",
                    { [LABEL.Target]: TARGET.Coordinator },
                ),
            ).rejects.toThrow("found 0");
        },
    );
    it("stops deadlines and sampling without publishing late completions or blocking shutdown", async () => {
        const telemetry = await processingTelemetry();
        clock();
        const pending = Promise.withResolvers<void>(),
            probe = vi.fn(() => pending.promise);
        const sampler = monitor(
            new RpcBudgetTransportMetrics(telemetry.metrics),
            { [TARGET.Broker]: probe, [TARGET.Coordinator]: probe },
        );
        await vi.advanceTimersByTimeAsync(POLICY.ProbeIntervalMs);
        expect(probe).toHaveBeenCalledTimes(2);
        sampler.stop();
        const before = await telemetry.metrics.metricsText();
        await vi.advanceTimersByTimeAsync(10 * POLICY.ProbeIntervalMs);
        pending.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(probe).toHaveBeenCalledTimes(2);
        expect(await telemetry.metrics.metricsText()).toBe(before);
    });
    it("telemetry errors do not stop sampling or throw from permission events", async () => {
        clock();
        const metrics = {
            increment: vi.fn(() => {
                throw new Error("export failure");
            }),
            gauge: vi.fn(),
            histogram: vi.fn(),
        };
        const observer = new RpcBudgetTransportMetrics(metrics);
        observer.event(EVENT.Granted, SYNC_WORK_CLASS.Main);
        const probe = vi.fn(async () => {});
        monitor(observer, {
            [TARGET.Broker]: probe,
            [TARGET.Coordinator]: probe,
        });
        await vi.advanceTimersByTimeAsync(2 * POLICY.ProbeIntervalMs);
        expect(probe).toHaveBeenCalledTimes(4);
        expect(metrics.increment).toHaveBeenCalledTimes(5);
    });
});
