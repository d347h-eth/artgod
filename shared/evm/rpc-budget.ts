import {
    TokenBucketRateLimiter,
    RPC_RATE_LIMIT_MODE,
    type RpcRateLimiterConfig,
} from "./rpc-resilience.js";
import {
    SYNC_WORK_CLASS,
    type SyncWorkClass,
} from "../types/sync-work-class.js";
import { RpcBudgetDeferred } from "./rpc-errors.js";
import { createHash } from "node:crypto";
export { RpcBudgetDeferred, getRpcBudgetDeferral } from "./rpc-errors.js";

/** Stable private identity shared across pools/processes; never expose endpoint credentials. */
export function rpcEndpointBudgetKey(url: string): string {
    return createHash("sha256").update(new URL(url).toString()).digest("hex");
}

export const GAP_FILL_MODE = {
    Disabled: "disabled",
    ...RPC_RATE_LIMIT_MODE,
} as const;

/** Disabled retains gap work; unlimited removes both gap-specific RPC limits. */
export type RpcGapAllocation =
    | { mode: typeof GAP_FILL_MODE.Disabled | typeof GAP_FILL_MODE.Unlimited }
    | {
          mode: typeof GAP_FILL_MODE.Limited;
          /** Per endpoint, shared across workers. */
          requestsPerSecond: number;
          /** Across all endpoints and workers sharing this budget. */
          maxInFlight: number;
      };

/** Reserve a smaller background allowance while keeping capacity for main work. */
export function assertRpcGapAllocation(
    gap: RpcGapAllocation,
    endpointLimits: readonly RpcRateLimiterConfig[],
): void {
    if (
        gap.mode === GAP_FILL_MODE.Disabled ||
        gap.mode === GAP_FILL_MODE.Unlimited
    )
        return;
    if (
        gap.mode !== GAP_FILL_MODE.Limited ||
        !Number.isFinite(gap.requestsPerSecond) ||
        gap.requestsPerSecond <= 0 ||
        !Number.isSafeInteger(gap.maxInFlight) ||
        gap.maxInFlight < 1
    )
        throw new Error("Invalid RPC gap allocation");
    for (const limit of endpointLimits)
        if (
            limit.mode === RPC_RATE_LIMIT_MODE.Limited &&
            gap.requestsPerSecond >= limit.requestsPerSecond
        )
            throw new Error(
                "Gap RPC allowance must be smaller than the endpoint allowance",
            );
}

export type RpcRequestBudgetInput = {
    endpointKey: string;
    workClass: SyncWorkClass;
};

/** The adapter holds a permit only while a network attempt runs. Retries acquire again. */
export interface RpcRequestBudget {
    run<T>(input: RpcRequestBudgetInput, request: () => Promise<T>): Promise<T>;
}

export const RPC_BUDGET_POLICY = {
    MaxPending: 1024,
    WaitMs: 30_000,
    LeaseGraceMs: 5_000,
} as const;

type Pending = RpcRequestBudgetInput & {
    id: string;
    expiresAt: number;
    grant: (id: string) => void;
    reject: () => void;
};
type Lease = RpcRequestBudgetInput & { expiresAt: number };

/** One process owns this scheduler; transports carry its grants to other workers.
 * Limited gaps retain their smooth reserved allowance under main load. Unlimited
 * gaps use available total capacity after main requests, without a concurrency cap. */
export class RpcBudgetScheduler {
    private readonly endpoints = new Map<
        string,
        { total: TokenBucketRateLimiter; gap: TokenBucketRateLimiter | null }
    >();
    private readonly pending = new Map<string, Pending>();
    private readonly leases = new Map<string, Lease>();
    private gapInFlight = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private stopped = false;

    constructor(
        endpoints: readonly { key: string; limit: RpcRateLimiterConfig }[],
        private readonly gap: RpcGapAllocation,
        private readonly leaseMs: number,
        private readonly now: () => number = Date.now,
    ) {
        assertRpcGapAllocation(
            gap,
            endpoints.map((endpoint) => endpoint.limit),
        );
        if (!Number.isSafeInteger(leaseMs) || leaseMs < 1)
            throw new Error("Invalid RPC attempt lease");
        for (const endpoint of endpoints) {
            this.endpoints.set(endpoint.key, {
                total: new TokenBucketRateLimiter(endpoint.limit, now),
                gap:
                    gap.mode === GAP_FILL_MODE.Limited
                        ? new TokenBucketRateLimiter(
                              {
                                  mode: RPC_RATE_LIMIT_MODE.Limited,
                                  requestsPerSecond: gap.requestsPerSecond,
                                  burst: 1,
                              },
                              now,
                          )
                        : null,
            });
        }
    }

    acquire(input: RpcRequestBudgetInput & { id: string }): Promise<string> {
        if (
            this.stopped ||
            this.pending.size >= RPC_BUDGET_POLICY.MaxPending ||
            !this.endpoints.has(input.endpointKey) ||
            this.pending.has(input.id) ||
            this.leases.has(input.id) ||
            (input.workClass === SYNC_WORK_CLASS.GapRepair &&
                this.gap.mode === GAP_FILL_MODE.Disabled)
        )
            return Promise.reject(new RpcBudgetDeferred());
        return new Promise((resolve, reject) => {
            this.pending.set(input.id, {
                ...input,
                expiresAt: this.now() + RPC_BUDGET_POLICY.WaitMs,
                grant: resolve,
                reject: () => reject(new RpcBudgetDeferred()),
            });
            this.drain();
        });
    }

    /** Cancelling a queued request consumes no rate or concurrency allowance. */
    cancel(id: string): void {
        const pending = this.pending.get(id);
        if (pending) {
            this.pending.delete(id);
            pending.reject();
        }
        this.release(id);
    }

    release(id: string): void {
        const lease = this.leases.get(id);
        if (lease) {
            this.leases.delete(id);
            if (lease.workClass === SYNC_WORK_CLASS.GapRepair)
                this.gapInFlight--;
        }
        this.drain();
    }

    snapshot() {
        return {
            mainWaiting: [...this.pending.values()].filter(
                (p) => p.workClass === SYNC_WORK_CLASS.Main,
            ).length,
            gapWaiting: [...this.pending.values()].filter(
                (p) => p.workClass === SYNC_WORK_CLASS.GapRepair,
            ).length,
            gapInFlight: this.gapInFlight,
        };
    }

    stop(): void {
        this.stopped = true;
        clearTimeout(this.timer);
        for (const pending of this.pending.values()) pending.reject();
        this.pending.clear();
        this.leases.clear();
        this.gapInFlight = 0;
    }

    private drain(): void {
        clearTimeout(this.timer);
        if (this.stopped) return;
        for (const [id, lease] of this.leases)
            if (lease.expiresAt <= this.now()) {
                this.leases.delete(id);
                if (lease.workClass === SYNC_WORK_CLASS.GapRepair)
                    this.gapInFlight--;
            }
        for (const [id, pending] of this.pending)
            if (pending.expiresAt <= this.now()) {
                this.pending.delete(id);
                pending.reject();
            }
        // Limited gaps may claim their reserved tokens. Unlimited gaps have no
        // reservation and yield to waiting main work on every eligible endpoint.
        for (;;) {
            const ready = [...this.pending.values()].filter(
                (p) =>
                    this.endpoints.get(p.endpointKey)!.total.waitTimeMs() === 0,
            );
            const nextGap = this.canStartGap()
                ? ready.find(
                      (p) =>
                          p.workClass === SYNC_WORK_CLASS.GapRepair &&
                          (this.endpoints
                              .get(p.endpointKey)!
                              .gap?.waitTimeMs() ?? 0) === 0,
                  )
                : undefined;
            const nextMain = ready.find(
                (p) => p.workClass === SYNC_WORK_CLASS.Main,
            );
            const next =
                this.gap.mode === GAP_FILL_MODE.Unlimited
                    ? (nextMain ?? nextGap)
                    : (nextGap ?? nextMain);
            if (!next) break;
            this.endpoints.get(next.endpointKey)!.total.tryAcquire();
            if (next.workClass === SYNC_WORK_CLASS.GapRepair) {
                this.endpoints.get(next.endpointKey)!.gap?.tryAcquire();
                this.gapInFlight++;
            }
            this.pending.delete(next.id);
            this.leases.set(next.id, {
                endpointKey: next.endpointKey,
                workClass: next.workClass,
                expiresAt: this.now() + this.leaseMs,
            });
            next.grant(next.id);
        }
        let wait = Infinity;
        for (const pending of this.pending.values()) {
            wait = Math.min(wait, pending.expiresAt - this.now());
            const endpointWait = this.endpoints
                .get(pending.endpointKey)!
                .total.waitTimeMs();
            if (pending.workClass === SYNC_WORK_CLASS.Main)
                wait = Math.min(wait, endpointWait);
            else if (this.canStartGap())
                wait = Math.min(
                    wait,
                    Math.max(
                        endpointWait,
                        this.endpoints
                            .get(pending.endpointKey)!
                            .gap?.waitTimeMs() ?? 0,
                    ),
                );
        }
        if (this.pending.size)
            for (const lease of this.leases.values())
                wait = Math.min(wait, lease.expiresAt - this.now());
        if (Number.isFinite(wait)) {
            this.timer = setTimeout(() => this.drain(), Math.max(1, wait));
            this.timer.unref?.();
        }
    }

    private canStartGap(): boolean {
        return (
            this.gap.mode === GAP_FILL_MODE.Unlimited ||
            (this.gap.mode === GAP_FILL_MODE.Limited &&
                this.gapInFlight < this.gap.maxInFlight)
        );
    }
}
