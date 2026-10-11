import { logger as defaultLogger, type LogLevel } from "../utils/logger.js";
import {
    classifiedRpcErrorClassName,
    RPC_DETERMINISTIC_CONTRACT_ERROR_CLASS_NAME,
    RPC_PROVIDER_HEAD_LAG_ERROR_CLASS_NAME,
    RPC_PROVIDER_STATE_UNAVAILABLE_ERROR_CLASS_NAME,
    RPC_PROVIDER_ZERO_DATA_ERROR_CLASS_NAME,
    RPC_RESPONSE_BODY_TOO_LARGE_ERROR_CLASS_NAME,
} from "../evm/rpc-errors.js";
import type { Metrics } from "./metrics/types.js";
import type { SyncWorkClass } from "../types/sync-work-class.js";
import { WindowedLogReporter } from "./log-reporting.js";

// Canonical workspace labels used by RPC logs and metrics.
export const RPC_OBSERVABILITY_WORKSPACE = {
    Backend: "backend",
    Indexer: "indexer",
    Trading: "trading",
} as const;

// Canonical protocol labels used by RPC logs and metrics.
export const RPC_PROTOCOL = {
    Http: "http",
    WebSocket: "websocket",
} as const;

// Canonical result labels used by RPC logs and metrics.
export const RPC_OBSERVABILITY_RESULT = {
    Success: "success",
    Failure: "failure",
    None: "none",
} as const;

// Canonical endpoint lifecycle event labels used by RPC observability.
export const RPC_OBSERVABILITY_EVENT = {
    Configured: "configured",
    AttemptStarted: "attempt_started",
    AttemptSucceeded: "attempt_succeeded",
    AttemptFailed: "attempt_failed",
    RetryScheduled: "retry_scheduled",
    RateLimiterWaited: "rate_limiter_waited",
    CircuitOpen: "circuit_open",
    ConnectStarted: "connect_started",
    Connected: "connected",
    HeadReceived: "head_received",
    ConnectionFailed: "connection_failed",
    ReconnectScheduled: "reconnect_scheduled",
    ConnectionStopped: "connection_stopped",
} as const;

// Canonical structured log action labels for shared RPC observer events.
export const RPC_OBSERVABILITY_LOG_ACTION = {
    Progress: "rpc_progress",
    EndpointAttemptStarted: "endpoint_attempt_started",
    EndpointAttemptSucceeded: "endpoint_attempt_succeeded",
    EndpointAttemptFailed: "endpoint_attempt_failed",
    CallSucceeded: "call_succeeded",
    CallFailed: "call_failed",
    RetryScheduled: RPC_OBSERVABILITY_EVENT.RetryScheduled,
    RateLimiterWaited: RPC_OBSERVABILITY_EVENT.RateLimiterWaited,
    CircuitOpen: RPC_OBSERVABILITY_EVENT.CircuitOpen,
} as const;

// Canonical human-readable log messages emitted by the shared RPC observer.
export const RPC_OBSERVABILITY_LOG_MESSAGE = {
    Progress: "RPC activity progress",
    EndpointConfigured: "RPC endpoint configured",
    EndpointAttemptStarted: "RPC endpoint attempt started",
    EndpointAttemptSucceeded: "RPC endpoint attempt succeeded",
    EndpointAttemptFailed: "RPC endpoint attempt failed",
    CallSucceeded: "RPC call succeeded",
    CallFailed: "RPC call failed",
    RetryScheduled: "RPC retry scheduled",
    RateLimiterWaited: "RPC rate limiter waited",
    CircuitOpen: "RPC circuit open",
    EndpointEvent: "RPC endpoint event",
    WebSocketConnectStarted: "RPC websocket connect started",
    WebSocketConnected: "RPC websocket connected",
    WebSocketHeadReceived: "RPC websocket head received",
    WebSocketEndpointFailed: "RPC websocket endpoint failed",
    WebSocketReconnectScheduled: "RPC websocket reconnect scheduled",
    WebSocketConnectionStopped: "RPC websocket connection stopped",
} as const;

// Canonical metric names emitted by the shared RPC observer.
export const RPC_OBSERVABILITY_METRIC = {
    Call: "rpc.call",
    CallDurationMs: "rpc.call.duration_ms",
    EndpointAttempt: "rpc.endpoint.attempt",
    EndpointAttemptDurationMs: "rpc.endpoint.attempt.duration_ms",
    EndpointEvent: "rpc.endpoint.event",
    EndpointConfiguredWeight: "rpc.endpoint.configured_weight",
    EndpointEffectiveWeight: "rpc.endpoint.effective_weight",
    RetryAttempt: "rpc.retry.attempt",
    CircuitOpen: "rpc.circuit_open",
    RateLimiterWaitMs: "rpc.rate_limiter.wait_ms",
} as const;

// Sentinel values used when an RPC metric dimension is intentionally absent.
export const RPC_OBSERVABILITY_SENTINEL = {
    NoEndpoint: "none",
    NoErrorClass: "none",
    NoMethod: "none",
    NoWorkClass: "none",
} as const;

export const RPC_OBSERVABILITY_LABEL = { WorkClass: "work_class" } as const;

// Canonical error_class labels emitted by the shared RPC observer.
export const RPC_OBSERVABILITY_ERROR_CLASS = {
    DeterministicContract: RPC_DETERMINISTIC_CONTRACT_ERROR_CLASS_NAME,
    ProviderHeadLag: RPC_PROVIDER_HEAD_LAG_ERROR_CLASS_NAME,
    ProviderStateUnavailable: RPC_PROVIDER_STATE_UNAVAILABLE_ERROR_CLASS_NAME,
    ProviderZeroData: RPC_PROVIDER_ZERO_DATA_ERROR_CLASS_NAME,
    ResponseBodyTooLarge: RPC_RESPONSE_BODY_TOO_LARGE_ERROR_CLASS_NAME,
    RequestTimeout: "RpcRequestTimeoutError",
} as const;

const DEFAULT_RPC_LOG_COMPONENT = "RpcAdapter";
const DEFAULT_RPC_ENDPOINT_EVENT_LOG_LEVEL: LogLevel = "debug";
const INVALID_URL_ORIGIN = "invalid-url";
const VIEM_TIMEOUT_ERROR_CLASS_NAME = "TimeoutError";
const PROVIDER_TIMEOUT_ERROR_CLASS_NAMES = new Set<string>([
    RPC_OBSERVABILITY_ERROR_CLASS.RequestTimeout,
    VIEM_TIMEOUT_ERROR_CLASS_NAME,
]);
const MAX_ERROR_CAUSE_CLASSIFICATION_DEPTH = 4;

export type RpcProtocol = (typeof RPC_PROTOCOL)[keyof typeof RPC_PROTOCOL];
export type RpcObservabilityWorkspace =
    (typeof RPC_OBSERVABILITY_WORKSPACE)[keyof typeof RPC_OBSERVABILITY_WORKSPACE];
export type RpcObservabilityResult =
    (typeof RPC_OBSERVABILITY_RESULT)[keyof typeof RPC_OBSERVABILITY_RESULT];
export type RpcObservabilityEvent =
    (typeof RPC_OBSERVABILITY_EVENT)[keyof typeof RPC_OBSERVABILITY_EVENT];

export type RpcEndpointSnapshot = {
    id: string;
    url: string;
    configuredWeight: number;
    effectiveWeight: number;
};

export type RpcObservabilityConfig = {
    workspace: RpcObservabilityWorkspace;
    component: string;
    protocol: RpcProtocol;
    metrics?: Metrics;
    logComponent?: string;
    logger?: typeof defaultLogger;
    /** Explicit diagnostic callers can also emit the original per-operation detail. */
    detailedLogs?: boolean;
};

export type RpcCallContext = {
    method: string;
    startedAtMs: number;
    workClass?: SyncWorkClass;
    logFields?: Record<string, unknown>;
};

export type RpcEndpointAttemptContext = RpcCallContext & {
    endpoint: RpcEndpointSnapshot;
    attempt: number;
    attemptStartedAtMs: number;
};

export type RpcRetryScheduledInput = {
    method: string;
    endpoint: RpcEndpointSnapshot;
    attempt: number;
    nextAttempt: number;
    delayMs: number;
    workClass?: SyncWorkClass;
    logFields?: Record<string, unknown>;
};

export type RpcRateLimitWaitInput = {
    method: string;
    endpoint: RpcEndpointSnapshot;
    waitedMs: number;
    workClass?: SyncWorkClass;
    logFields?: Record<string, unknown>;
};

export type RpcEndpointEventInput = {
    event: RpcObservabilityEvent;
    method: string;
    endpoint: RpcEndpointSnapshot;
    workClass?: SyncWorkClass;
    level?: LogLevel;
    message?: string;
    extra?: Record<string, unknown>;
};

// RpcObservability centralizes JSON-RPC logs and matching low-cardinality metrics.
export class RpcObservability {
    private readonly metrics?: Metrics;
    private readonly log: typeof defaultLogger;
    private readonly logComponent: string;
    private readonly progress: WindowedLogReporter<
        ReturnType<typeof emptyRpcProgress>
    >;

    constructor(private readonly config: RpcObservabilityConfig) {
        this.metrics = config.metrics;
        this.log = config.logger ?? defaultLogger;
        this.logComponent = config.logComponent ?? DEFAULT_RPC_LOG_COMPONENT;
        this.progress = new WindowedLogReporter(
            emptyRpcProgress,
            (counts, window) => {
                this.log.info(RPC_OBSERVABILITY_LOG_MESSAGE.Progress, {
                    component: this.logComponent,
                    workspace: config.workspace,
                    rpcComponent: config.component,
                    protocol: config.protocol,
                    action: RPC_OBSERVABILITY_LOG_ACTION.Progress,
                    ...window,
                    ...counts,
                });
            },
        );
    }

    recordConfiguredEndpoint(endpoint: RpcEndpointSnapshot): void {
        this.recordEndpointWeightGauges(endpoint);
        this.recordEndpointEvent({
            event: RPC_OBSERVABILITY_EVENT.Configured,
            method: RPC_OBSERVABILITY_SENTINEL.NoMethod,
            endpoint,
            message: RPC_OBSERVABILITY_LOG_MESSAGE.EndpointConfigured,
        });
    }

    startCall(
        method: string,
        logFields?: Record<string, unknown>,
        workClass?: SyncWorkClass,
    ): RpcCallContext {
        this.progress.record((counts) => counts.callsStarted++);
        return {
            method,
            startedAtMs: Date.now(),
            workClass,
            ...(logFields ? { logFields } : {}),
        };
    }

    startEndpointAttempt(
        call: RpcCallContext,
        endpoint: RpcEndpointSnapshot,
        attempt: number,
    ): RpcEndpointAttemptContext {
        const context = {
            ...call,
            endpoint,
            attempt,
            attemptStartedAtMs: Date.now(),
        };
        this.recordEndpointWeightGauges(endpoint);
        this.progress.record((counts) => counts.attemptsStarted++);
        if (this.config.detailedLogs)
            this.log.debug(
                RPC_OBSERVABILITY_LOG_MESSAGE.EndpointAttemptStarted,
                {
                    ...this.baseLogFields(
                        RPC_OBSERVABILITY_LOG_ACTION.EndpointAttemptStarted,
                        call.method,
                    ),
                    ...this.rpcCallLogFields(call),
                    ...this.endpointLogFields(endpoint),
                    attempt,
                },
            );
        this.incrementEndpointEvent({
            event: RPC_OBSERVABILITY_EVENT.AttemptStarted,
            method: call.method,
            endpoint,
            workClass: call.workClass,
        });
        return context;
    }

    recordEndpointAttemptSuccess(
        context: RpcEndpointAttemptContext,
        endpoint: RpcEndpointSnapshot,
    ): void {
        const durationMs = elapsedMs(context.attemptStartedAtMs);
        this.progress.record((counts) => {
            counts.attemptsSucceeded++;
            counts.attemptDurationMs += durationMs;
            counts.maximumAttemptDurationMs = Math.max(
                counts.maximumAttemptDurationMs,
                durationMs,
            );
        });
        this.recordEndpointWeightGauges(endpoint);
        if (this.config.detailedLogs)
            this.log.debug(
                RPC_OBSERVABILITY_LOG_MESSAGE.EndpointAttemptSucceeded,
                {
                    ...this.baseLogFields(
                        RPC_OBSERVABILITY_LOG_ACTION.EndpointAttemptSucceeded,
                        context.method,
                    ),
                    ...this.rpcCallLogFields(context),
                    ...this.endpointLogFields(endpoint),
                    attempt: context.attempt,
                    durationMs,
                },
            );
        this.recordEndpointAttemptMetric(
            context,
            endpoint,
            RPC_OBSERVABILITY_RESULT.Success,
            RPC_OBSERVABILITY_SENTINEL.NoErrorClass,
            durationMs,
        );
        this.incrementEndpointEvent({
            event: RPC_OBSERVABILITY_EVENT.AttemptSucceeded,
            method: context.method,
            endpoint,
            workClass: context.workClass,
        });
    }

    recordEndpointAttemptFailure(
        context: RpcEndpointAttemptContext,
        endpoint: RpcEndpointSnapshot,
        error: unknown,
    ): void {
        const durationMs = elapsedMs(context.attemptStartedAtMs);
        const errorClass = errorClassName(error);
        this.progress.record((counts) => {
            counts.attemptsFailed++;
            counts.attemptDurationMs += durationMs;
            counts.maximumAttemptDurationMs = Math.max(
                counts.maximumAttemptDurationMs,
                durationMs,
            );
        });
        this.recordEndpointWeightGauges(endpoint);
        this.log.warn(RPC_OBSERVABILITY_LOG_MESSAGE.EndpointAttemptFailed, {
            ...this.baseLogFields(
                RPC_OBSERVABILITY_LOG_ACTION.EndpointAttemptFailed,
                context.method,
            ),
            ...this.rpcCallLogFields(context),
            ...this.endpointLogFields(endpoint),
            ...errorLogFields(error),
            attempt: context.attempt,
            durationMs,
        });
        this.recordEndpointAttemptMetric(
            context,
            endpoint,
            RPC_OBSERVABILITY_RESULT.Failure,
            errorClass,
            durationMs,
        );
        this.incrementEndpointEvent({
            event: RPC_OBSERVABILITY_EVENT.AttemptFailed,
            method: context.method,
            endpoint,
            result: RPC_OBSERVABILITY_RESULT.Failure,
            errorClass,
            workClass: context.workClass,
        });
    }

    recordCallSuccess(
        call: RpcCallContext,
        endpoint: RpcEndpointSnapshot,
    ): void {
        const durationMs = elapsedMs(call.startedAtMs);
        this.progress.record((counts) => {
            counts.callsSucceeded++;
            counts.callDurationMs += durationMs;
            counts.maximumCallDurationMs = Math.max(
                counts.maximumCallDurationMs,
                durationMs,
            );
        });
        if (this.config.detailedLogs)
            this.log.debug(RPC_OBSERVABILITY_LOG_MESSAGE.CallSucceeded, {
                ...this.baseLogFields(
                    RPC_OBSERVABILITY_LOG_ACTION.CallSucceeded,
                    call.method,
                ),
                ...this.rpcCallLogFields(call),
                ...this.endpointLogFields(endpoint),
                durationMs,
            });
        this.recordCallMetric(
            call,
            endpoint,
            RPC_OBSERVABILITY_RESULT.Success,
            RPC_OBSERVABILITY_SENTINEL.NoErrorClass,
            durationMs,
        );
    }

    recordCallFailure(
        call: RpcCallContext,
        endpoint: RpcEndpointSnapshot | null,
        error: unknown,
    ): void {
        const durationMs = elapsedMs(call.startedAtMs);
        const errorClass = errorClassName(error);
        this.progress.record((counts) => {
            counts.callsFailed++;
            counts.callDurationMs += durationMs;
            counts.maximumCallDurationMs = Math.max(
                counts.maximumCallDurationMs,
                durationMs,
            );
        });
        this.log.warn(RPC_OBSERVABILITY_LOG_MESSAGE.CallFailed, {
            ...this.baseLogFields(
                RPC_OBSERVABILITY_LOG_ACTION.CallFailed,
                call.method,
            ),
            ...this.rpcCallLogFields(call),
            ...(endpoint ? this.endpointLogFields(endpoint) : {}),
            ...errorLogFields(error),
            durationMs,
        });
        this.recordCallMetric(
            call,
            endpoint,
            RPC_OBSERVABILITY_RESULT.Failure,
            errorClass,
            durationMs,
        );
    }

    recordRetryScheduled(input: RpcRetryScheduledInput): void {
        this.progress.record((counts) => counts.retriesScheduled++);
        this.log.warn(RPC_OBSERVABILITY_LOG_MESSAGE.RetryScheduled, {
            ...this.baseLogFields(
                RPC_OBSERVABILITY_LOG_ACTION.RetryScheduled,
                input.method,
            ),
            ...this.rpcCallLogFields(input),
            ...this.endpointLogFields(input.endpoint),
            attempt: input.attempt,
            nextAttempt: input.nextAttempt,
            delayMs: input.delayMs,
        });
        this.metrics?.increment(RPC_OBSERVABILITY_METRIC.RetryAttempt, 1, {
            ...this.baseMetricLabels(input),
            attempt: input.attempt,
            next_attempt: input.nextAttempt,
        });
        this.incrementEndpointEvent({
            event: RPC_OBSERVABILITY_EVENT.RetryScheduled,
            ...input,
        });
    }

    recordRateLimitWait(input: RpcRateLimitWaitInput): void {
        this.progress.record((counts) => {
            counts.rateLimitWaits++;
            counts.rateLimitWaitMs += input.waitedMs;
            counts.maximumRateLimitWaitMs = Math.max(
                counts.maximumRateLimitWaitMs,
                input.waitedMs,
            );
        });
        if (this.config.detailedLogs)
            this.log.debug(RPC_OBSERVABILITY_LOG_MESSAGE.RateLimiterWaited, {
                ...this.baseLogFields(
                    RPC_OBSERVABILITY_LOG_ACTION.RateLimiterWaited,
                    input.method,
                ),
                ...this.rpcCallLogFields(input),
                ...this.endpointLogFields(input.endpoint),
                waitedMs: input.waitedMs,
            });
        this.metrics?.histogram(
            RPC_OBSERVABILITY_METRIC.RateLimiterWaitMs,
            input.waitedMs,
            {
                ...this.baseMetricLabels(input),
            },
        );
        this.incrementEndpointEvent({
            event: RPC_OBSERVABILITY_EVENT.RateLimiterWaited,
            ...input,
        });
    }

    recordCircuitOpen(
        method: string,
        endpoint: RpcEndpointSnapshot,
        error: unknown,
        logFields?: Record<string, unknown>,
        workClass?: SyncWorkClass,
    ): void {
        this.progress.record((counts) => counts.circuitsOpened++);
        this.log.warn(RPC_OBSERVABILITY_LOG_MESSAGE.CircuitOpen, {
            ...this.baseLogFields(
                RPC_OBSERVABILITY_LOG_ACTION.CircuitOpen,
                method,
            ),
            ...this.rpcCallLogFields({ logFields, workClass }),
            ...this.endpointLogFields(endpoint),
            ...errorLogFields(error),
        });
        this.metrics?.increment(RPC_OBSERVABILITY_METRIC.CircuitOpen, 1, {
            ...this.baseMetricLabels({ method, endpoint, workClass }),
            error_class: errorClassName(error),
        });
        this.incrementEndpointEvent({
            event: RPC_OBSERVABILITY_EVENT.CircuitOpen,
            method,
            endpoint,
            result: RPC_OBSERVABILITY_RESULT.Failure,
            errorClass: errorClassName(error),
            workClass,
        });
    }

    recordEndpointEvent(input: RpcEndpointEventInput): void {
        const level = input.level ?? DEFAULT_RPC_ENDPOINT_EVENT_LOG_LEVEL;
        const head = input.event === RPC_OBSERVABILITY_EVENT.HeadReceived;
        if (head) this.progress.record((counts) => counts.headsReceived++);
        if (
            !head ||
            level === "warn" ||
            level === "error" ||
            this.config.detailedLogs
        )
            this.log[level](
                input.message ?? RPC_OBSERVABILITY_LOG_MESSAGE.EndpointEvent,
                {
                    ...this.baseLogFields(input.event, input.method),
                    ...this.endpointLogFields(input.endpoint),
                    ...(input.extra ?? {}),
                    ...(input.workClass ? { workClass: input.workClass } : {}),
                },
            );
        this.recordEndpointWeightGauges(input.endpoint);
        this.incrementEndpointEvent(input);
    }

    private recordCallMetric(
        call: RpcCallContext,
        endpoint: RpcEndpointSnapshot | null,
        result: RpcObservabilityResult,
        errorClass: string,
        durationMs: number,
    ): void {
        const labels = this.baseMetricLabels({
            ...call,
            endpoint,
            result,
            errorClass,
        });
        this.metrics?.increment(RPC_OBSERVABILITY_METRIC.Call, 1, labels);
        this.metrics?.histogram(
            RPC_OBSERVABILITY_METRIC.CallDurationMs,
            durationMs,
            labels,
        );
    }

    private recordEndpointAttemptMetric(
        context: RpcEndpointAttemptContext,
        endpoint: RpcEndpointSnapshot,
        result: RpcObservabilityResult,
        errorClass: string,
        durationMs: number,
    ): void {
        const labels = this.baseMetricLabels({
            ...context,
            endpoint,
            result,
            errorClass,
        });
        this.metrics?.increment(
            RPC_OBSERVABILITY_METRIC.EndpointAttempt,
            1,
            labels,
        );
        this.metrics?.histogram(
            RPC_OBSERVABILITY_METRIC.EndpointAttemptDurationMs,
            durationMs,
            labels,
        );
    }

    private incrementEndpointEvent(input: {
        event: RpcObservabilityEvent;
        method: string;
        endpoint: RpcEndpointSnapshot;
        result?: RpcObservabilityResult;
        errorClass?: string;
        workClass?: SyncWorkClass;
    }): void {
        this.metrics?.increment(RPC_OBSERVABILITY_METRIC.EndpointEvent, 1, {
            ...this.baseMetricLabels(input),
            event: input.event,
        });
    }

    private recordEndpointWeightGauges(endpoint: RpcEndpointSnapshot): void {
        const labels = {
            component: this.config.component,
            protocol: this.config.protocol,
            endpoint: endpoint.id,
        };
        this.metrics?.gauge(
            RPC_OBSERVABILITY_METRIC.EndpointConfiguredWeight,
            endpoint.configuredWeight,
            labels,
        );
        this.metrics?.gauge(
            RPC_OBSERVABILITY_METRIC.EndpointEffectiveWeight,
            endpoint.effectiveWeight,
            labels,
        );
    }

    private baseMetricLabels(input: {
        method: string;
        endpoint: RpcEndpointSnapshot | null;
        result?: RpcObservabilityResult;
        errorClass?: string;
        workClass?: SyncWorkClass;
    }): Record<string, string | number> {
        return {
            component: this.config.component,
            protocol: this.config.protocol,
            method: input.method,
            endpoint:
                input.endpoint?.id ?? RPC_OBSERVABILITY_SENTINEL.NoEndpoint,
            result: input.result ?? RPC_OBSERVABILITY_RESULT.None,
            error_class:
                input.errorClass ?? RPC_OBSERVABILITY_SENTINEL.NoErrorClass,
            [RPC_OBSERVABILITY_LABEL.WorkClass]:
                input.workClass ?? RPC_OBSERVABILITY_SENTINEL.NoWorkClass,
        };
    }

    private baseLogFields(
        action: string,
        method: string,
    ): Record<string, unknown> {
        return {
            component: this.logComponent,
            action,
            workspace: this.config.workspace,
            rpcComponent: this.config.component,
            protocol: this.config.protocol,
            method,
        };
    }

    private endpointLogFields(
        endpoint: RpcEndpointSnapshot,
    ): Record<string, unknown> {
        return {
            endpointId: endpoint.id,
            endpointOrigin: safeEndpointOrigin(endpoint.url),
            configuredWeight: endpoint.configuredWeight,
            effectiveWeight: endpoint.effectiveWeight,
        };
    }

    private rpcCallLogFields(
        context: Pick<RpcCallContext, "logFields" | "workClass">,
    ): Record<string, unknown> {
        return {
            ...(context.logFields ?? {}),
            ...(context.workClass ? { workClass: context.workClass } : {}),
        };
    }
}

// Counter storage is constant-size regardless of methods, endpoints, calls or wallets.
function emptyRpcProgress() {
    return {
        callsStarted: 0,
        callsSucceeded: 0,
        callsFailed: 0,
        attemptsStarted: 0,
        attemptsSucceeded: 0,
        attemptsFailed: 0,
        retriesScheduled: 0,
        circuitsOpened: 0,
        headsReceived: 0,
        rateLimitWaits: 0,
        rateLimitWaitMs: 0,
        maximumRateLimitWaitMs: 0,
        callDurationMs: 0,
        maximumCallDurationMs: 0,
        attemptDurationMs: 0,
        maximumAttemptDurationMs: 0,
    };
}

export function errorClassName(error: unknown): string {
    const normalizedClassName = normalizedRpcErrorClassName(error);
    if (normalizedClassName) {
        return normalizedClassName;
    }
    if (error instanceof Error && error.name.trim().length > 0) {
        return error.name;
    }
    return typeof error;
}

export function errorLogFields(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        const candidate = error as Error & { code?: unknown };
        return {
            error: sanitizeRpcErrorMessage(error.message),
            errorClass: errorClassName(error),
            ...(candidate.code !== undefined
                ? { errorCode: candidate.code }
                : {}),
        };
    }
    return {
        error: sanitizeRpcErrorMessage(String(error)),
        errorClass: errorClassName(error),
    };
}

function elapsedMs(startedAtMs: number): number {
    return Math.max(0, Date.now() - startedAtMs);
}

function safeEndpointOrigin(url: string): string {
    try {
        return new URL(url).origin;
    } catch {
        return INVALID_URL_ORIGIN;
    }
}

function sanitizeRpcErrorMessage(message: string): string {
    return message.replace(/(https?|wss?):\/\/[^\s)]+/g, (rawUrl) =>
        safeEndpointOrigin(rawUrl),
    );
}

function normalizedRpcErrorClassName(
    error: unknown,
    depth = 0,
): string | undefined {
    const classified = classifiedRpcErrorClassName(error);
    if (classified) {
        return classified;
    }

    if (depth > MAX_ERROR_CAUSE_CLASSIFICATION_DEPTH) {
        return undefined;
    }

    if (error instanceof Error) {
        if (PROVIDER_TIMEOUT_ERROR_CLASS_NAMES.has(error.name)) {
            return RPC_OBSERVABILITY_ERROR_CLASS.RequestTimeout;
        }

        const cause = (error as Error & { cause?: unknown }).cause;
        if (cause !== undefined) {
            return normalizedRpcErrorClassName(cause, depth + 1);
        }
    }

    return undefined;
}
