import { ErrorCode } from "nats";
import {
    RPC_BUDGET_METRIC_POLICY,
    RPC_BUDGET_PROBE_RESULT,
    RPC_BUDGET_PROBE_TARGET,
    type RpcBudgetProbeTarget,
    type RpcBudgetProbeResult,
    type RpcBudgetTransportMetrics,
} from "./budget-metrics.js";

type ProbeState = {
    deadline: ReturnType<typeof setTimeout>;
    reported: boolean;
};

/** Fixed-cost health samples, independent of permission queues and RPC work.
 * A stalled native PING keeps its slot until it settles: deadlines report failure
 * without accumulating unbounded PING promises during a broker outage. */
export class RpcBudgetTransportMonitor {
    private timer?: ReturnType<typeof setInterval>;
    private readonly pending = new Map<RpcBudgetProbeTarget, ProbeState>();
    private stopped = false;

    constructor(
        private readonly observer: RpcBudgetTransportMetrics,
        private readonly probes: Record<
            RpcBudgetProbeTarget,
            () => Promise<unknown>
        >,
    ) {}

    start(): void {
        if (this.timer || this.stopped) return;
        this.timer = setInterval(() => {
            this.sample(RPC_BUDGET_PROBE_TARGET.Broker);
            this.sample(RPC_BUDGET_PROBE_TARGET.Coordinator);
        }, RPC_BUDGET_METRIC_POLICY.ProbeIntervalMs);
        this.timer.unref();
    }

    stop(): void {
        this.stopped = true;
        clearInterval(this.timer);
        for (const state of this.pending.values()) clearTimeout(state.deadline);
        this.pending.clear();
    }

    private sample(target: RpcBudgetProbeTarget): void {
        if (this.stopped || this.pending.has(target)) return;
        const startedAt = performance.now();
        const report = (result: RpcBudgetProbeResult) => {
            if (this.stopped || state.reported) return;
            state.reported = true;
            this.observer.probeCompleted({
                target,
                result,
                durationMs: Math.max(0, performance.now() - startedAt),
                completedAtMs: Date.now(),
            });
        };
        const state: ProbeState = {
            deadline: setTimeout(
                () => report(RPC_BUDGET_PROBE_RESULT.Timeout),
                RPC_BUDGET_METRIC_POLICY.ProbeTimeoutMs,
            ),
            reported: false,
        };
        state.deadline.unref();
        this.pending.set(target, state);
        void Promise.resolve()
            .then(this.probes[target])
            .then(
                () => report(RPC_BUDGET_PROBE_RESULT.Success),
                (error: unknown) => {
                    const code =
                        typeof error === "object" &&
                        error !== null &&
                        "code" in error
                            ? error.code
                            : undefined;
                    report(
                        code === ErrorCode.Timeout
                            ? RPC_BUDGET_PROBE_RESULT.Timeout
                            : code === ErrorCode.NoResponders
                              ? RPC_BUDGET_PROBE_RESULT.Unavailable
                              : RPC_BUDGET_PROBE_RESULT.Error,
                    );
                },
            )
            .finally(() => {
                clearTimeout(state.deadline);
                this.pending.delete(target);
            });
    }
}
