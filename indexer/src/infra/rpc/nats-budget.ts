import { randomUUID } from "node:crypto";
import {
    connect,
    ErrorCode,
    JSONCodec,
    type NatsConnection,
    type Subscription,
} from "nats";
import {
    RPC_BUDGET_POLICY,
    GAP_FILL_MODE,
    RpcBudgetScheduler,
    RpcBudgetDeferred,
    rpcEndpointBudgetKey,
    type RpcRequestBudget,
    type RpcRequestBudgetInput,
    type RpcGapAllocation,
} from "@artgod/shared/evm/rpc-budget";
import {
    TokenBucketRateLimiter,
    type RpcRateLimiterConfig,
} from "@artgod/shared/evm/rpc-resilience";
import {
    SYNC_WORK_CLASS,
    decodeSyncWorkClass,
} from "@artgod/shared/types/sync-work-class";

const SUBJECT_TOKEN = "rpc-budget";
const ACTION = {
    Acquire: "acquire",
    Release: "release",
    Cancel: "cancel",
} as const;
const WAIT_REASON = {
    Capacity: "capacity",
    Restarting: "restarting",
    Paused: "paused",
    Unavailable: "unavailable",
} as const;
const codec = JSONCodec<unknown>();
type AcquireRequest = RpcRequestBudgetInput & { id: string };
type BudgetResponse =
    | { permitId: string }
    | {
          retryAfterMs: number;
          reason: (typeof WAIT_REASON)[keyof typeof WAIT_REASON];
      };
function decodeRecord(data: Uint8Array): Record<string, unknown> {
    const input = codec.decode(data);
    if (!input || typeof input !== "object" || Array.isArray(input))
        throw new RpcBudgetDeferred();
    return input as Record<string, unknown>;
}
function decodeAcquire(data: Uint8Array): AcquireRequest {
    const input = decodeRecord(data);
    if (
        typeof input.id !== "string" ||
        !/^[0-9a-f-]{36}$/.test(input.id) ||
        typeof input.endpointKey !== "string" ||
        !/^[0-9a-f]{64}$/.test(input.endpointKey) ||
        input.workClass === undefined
    )
        throw new RpcBudgetDeferred();
    return {
        id: input.id,
        endpointKey: input.endpointKey,
        workClass: decodeSyncWorkClass(input.workClass),
    };
}
function decodeResponse(data: Uint8Array): BudgetResponse {
    const response = decodeRecord(data);
    if (typeof response.permitId === "string")
        return { permitId: response.permitId };
    if (
        typeof response.retryAfterMs === "number" &&
        Number.isSafeInteger(response.retryAfterMs) &&
        response.retryAfterMs > 0 &&
        Object.values(WAIT_REASON).some((reason) => reason === response.reason)
    )
        return {
            retryAfterMs: response.retryAfterMs,
            reason: response.reason as (typeof WAIT_REASON)[keyof typeof WAIT_REASON],
        };
    throw new RpcBudgetDeferred();
}
type Config = {
    natsUrl: string;
    streamPrefix: string;
    chainId: number;
    endpoints: readonly { url: string }[];
    endpointLimit: RpcRateLimiterConfig;
    gap: RpcGapAllocation;
    requestTimeoutMs: number;
};

/** The HEAD scheduler runtime owns one allocation service per chain on the existing local broker.
 * Other pipeline runtimes use this client; no endpoint data or grants enter JetStream. */
export class NatsRpcBudget implements RpcRequestBudget {
    private readonly fallback = new Map<string, TokenBucketRateLimiter>();
    private readonly pending = new Map<string, () => void>();
    private readonly subscriptions: Subscription[] = [];
    private scheduler?: RpcBudgetScheduler;
    private stopped = false;

    private constructor(
        private readonly nc: NatsConnection,
        private readonly config: Config,
    ) {
        for (const endpoint of config.endpoints)
            this.fallback.set(
                rpcEndpointBudgetKey(endpoint.url),
                new TokenBucketRateLimiter(config.endpointLimit),
            );
    }

    static async connect(config: Config): Promise<NatsRpcBudget> {
        return new NatsRpcBudget(
            await connect({ servers: config.natsUrl }),
            config,
        );
    }

    /** Only the normal composition's sole HEAD scheduler starts the budget owner. */
    async serve(): Promise<void> {
        if (this.scheduler) throw new Error("RPC budget owner already started");
        const leaseMs =
            this.config.requestTimeoutMs + RPC_BUDGET_POLICY.LeaseGraceMs;
        this.scheduler = new RpcBudgetScheduler(
            this.config.endpoints.map((endpoint) => ({
                key: rpcEndpointBudgetKey(endpoint.url),
                limit: this.config.endpointLimit,
            })),
            this.config.gap,
            leaseMs,
        );
        // A previous owner may have crashed while a bounded HTTP attempt was running.
        // Main startup stays available; new background permits wait for those attempts.
        const backgroundReadyAt = Date.now() + leaseMs;
        this.subscriptions.push(
            this.nc.subscribe(this.subject(ACTION.Acquire), {
                callback: (_error, msg) => {
                    try {
                        const input = decodeAcquire(msg.data);
                        if (!this.fallback.has(input.endpointKey)) {
                            msg.respond(
                                codec.encode({
                                    retryAfterMs: 1000,
                                    reason: WAIT_REASON.Unavailable,
                                }),
                            );
                            return;
                        }
                        if (input.workClass === SYNC_WORK_CLASS.GapRepair) {
                            if (
                                this.config.gap.mode === GAP_FILL_MODE.Disabled
                            ) {
                                msg.respond(
                                    codec.encode({
                                        retryAfterMs: 1000,
                                        reason: WAIT_REASON.Paused,
                                    }),
                                );
                                return;
                            }
                            if (Date.now() < backgroundReadyAt) {
                                msg.respond(
                                    codec.encode({
                                        retryAfterMs:
                                            backgroundReadyAt - Date.now(),
                                        reason: WAIT_REASON.Restarting,
                                    }),
                                );
                                return;
                            }
                        }
                        this.scheduler!.acquire(input).then(
                            (permitId) =>
                                msg.respond(codec.encode({ permitId })),
                            () =>
                                msg.respond(
                                    codec.encode({
                                        retryAfterMs: 1_000,
                                        reason: WAIT_REASON.Capacity,
                                    }),
                                ),
                        );
                    } catch (error) {
                        msg.respond(
                            codec.encode({
                                reason: WAIT_REASON.Unavailable,
                                retryAfterMs:
                                    error instanceof RpcBudgetDeferred
                                        ? error.retryAfterMs
                                        : 1_000,
                            }),
                        );
                    }
                },
            }),
        );
        for (const action of [ACTION.Release, ACTION.Cancel])
            this.subscriptions.push(
                this.nc.subscribe(this.subject(action), {
                    callback: (_error, msg) => {
                        try {
                            const { id } = decodeRecord(msg.data);
                            if (typeof id === "string")
                                action === ACTION.Cancel
                                    ? this.scheduler!.cancel(id)
                                    : this.scheduler!.release(id);
                        } catch {
                            /* Malformed transient messages cannot alter permits. */
                        }
                    },
                }),
            );
        await this.nc.flush();
    }

    async run<T>(
        input: RpcRequestBudgetInput,
        request: () => Promise<T>,
    ): Promise<T> {
        if (this.stopped) throw new RpcBudgetDeferred();
        const id = randomUUID();
        let granted = false;
        let fallback = false;
        const cancelled = new Promise<never>((_resolve, reject) => {
            this.pending.set(id, () => reject(new RpcBudgetDeferred()));
        });
        try {
            // A transport wait is bounded; the logical request may keep waiting.
            // Rejoin allocation without discarding earlier block/metadata reads.
            while (!granted && !fallback) {
                let retryAfterMs = 1_000;
                try {
                    const msg = await Promise.race([
                        this.nc.request(
                            this.subject(ACTION.Acquire),
                            codec.encode({ ...input, id }),
                            { timeout: RPC_BUDGET_POLICY.WaitMs },
                        ),
                        cancelled,
                    ]);
                    const response = decodeResponse(msg.data);
                    if ("permitId" in response) {
                        if (response.permitId !== id)
                            throw new RpcBudgetDeferred();
                        granted = true;
                        break;
                    }
                    if (
                        response.reason === WAIT_REASON.Paused ||
                        response.reason === WAIT_REASON.Unavailable
                    )
                        throw new RpcBudgetDeferred(response.retryAfterMs);
                    retryAfterMs = response.retryAfterMs;
                } catch (error) {
                    const code =
                        typeof error === "object" &&
                        error !== null &&
                        "code" in error
                            ? error.code
                            : undefined;
                    // Standalone/main startup keeps the established per-client limiter.
                    // Missing ownership never lets background bypass its allocation.
                    if (
                        input.workClass === SYNC_WORK_CLASS.Main &&
                        !this.stopped &&
                        code === ErrorCode.NoResponders
                    ) {
                        const limiter = this.fallback.get(input.endpointKey);
                        if (!limiter) throw new RpcBudgetDeferred();
                        await Promise.race([limiter.acquire(), cancelled]);
                        fallback = true;
                        break;
                    }
                    if (this.stopped || code !== ErrorCode.Timeout)
                        throw error instanceof RpcBudgetDeferred
                            ? error
                            : new RpcBudgetDeferred();
                }
                this.nc.publish(
                    this.subject(ACTION.Cancel),
                    codec.encode({ id }),
                );
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    await Promise.race([
                        new Promise<void>((resolve) => {
                            timer = setTimeout(resolve, retryAfterMs);
                        }),
                        cancelled,
                    ]);
                } finally {
                    clearTimeout(timer);
                }
            }
            this.pending.delete(id);
            if (this.stopped) throw new RpcBudgetDeferred();
            return await request();
        } finally {
            this.pending.delete(id);
            if (!fallback)
                this.nc.publish(
                    this.subject(granted ? ACTION.Release : ACTION.Cancel),
                    codec.encode({ id }),
                );
        }
    }

    /** Interrupt capacity waits before draining handlers; requests already sent finish. */
    stopWaiting(): void {
        this.stopped = true;
        for (const [id, cancel] of this.pending) {
            this.nc.publish(this.subject(ACTION.Cancel), codec.encode({ id }));
            cancel();
        }
        this.pending.clear();
    }

    async close(): Promise<void> {
        this.stopWaiting();
        this.scheduler?.stop();
        for (const subscription of this.subscriptions)
            subscription.unsubscribe();
        await this.nc.drain();
    }

    private subject(action: (typeof ACTION)[keyof typeof ACTION]): string {
        return `${this.config.streamPrefix}.${SUBJECT_TOKEN}.${this.config.chainId}.${action}`;
    }
}
