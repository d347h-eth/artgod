import { logger as defaultLogger, type LogLevel } from "../utils/logger.js";
import type { Metrics } from "./metrics/types.js";

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
} as const;

const DEFAULT_RPC_LOG_COMPONENT = "RpcAdapter";
const DEFAULT_RPC_ENDPOINT_EVENT_LOG_LEVEL: LogLevel = "debug";
const INVALID_URL_ORIGIN = "invalid-url";

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
};

export type RpcCallContext = {
    method: string;
    startedAtMs: number;
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
};

export type RpcRateLimitWaitInput = {
    method: string;
    endpoint: RpcEndpointSnapshot;
    waitedMs: number;
};

export type RpcEndpointEventInput = {
    event: RpcObservabilityEvent;
    method: string;
    endpoint: RpcEndpointSnapshot;
    level?: LogLevel;
    message?: string;
    extra?: Record<string, unknown>;
};

// RpcObservability centralizes JSON-RPC logs and matching low-cardinality metrics.
export class RpcObservability {
    private readonly metrics?: Metrics;
    private readonly log: typeof defaultLogger;
    private readonly logComponent: string;

    constructor(private readonly config: RpcObservabilityConfig) {
        this.metrics = config.metrics;
        this.log = config.logger ?? defaultLogger;
        this.logComponent = config.logComponent ?? DEFAULT_RPC_LOG_COMPONENT;
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

    startCall(method: string): RpcCallContext {
        return {
            method,
            startedAtMs: Date.now(),
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
        this.log.debug(RPC_OBSERVABILITY_LOG_MESSAGE.EndpointAttemptStarted, {
            ...this.baseLogFields(
                RPC_OBSERVABILITY_LOG_ACTION.EndpointAttemptStarted,
                call.method,
            ),
            ...this.endpointLogFields(endpoint),
            attempt,
        });
        this.incrementEndpointEvent(
            RPC_OBSERVABILITY_EVENT.AttemptStarted,
            call.method,
            endpoint,
        );
        return context;
    }

    recordEndpointAttemptSuccess(
        context: RpcEndpointAttemptContext,
        endpoint: RpcEndpointSnapshot,
    ): void {
        const durationMs = elapsedMs(context.attemptStartedAtMs);
        this.recordEndpointWeightGauges(endpoint);
        this.log.debug(RPC_OBSERVABILITY_LOG_MESSAGE.EndpointAttemptSucceeded, {
            ...this.baseLogFields(
                RPC_OBSERVABILITY_LOG_ACTION.EndpointAttemptSucceeded,
                context.method,
            ),
            ...this.endpointLogFields(endpoint),
            attempt: context.attempt,
            durationMs,
        });
        this.recordEndpointAttemptMetric(
            context.method,
            endpoint,
            RPC_OBSERVABILITY_RESULT.Success,
            RPC_OBSERVABILITY_SENTINEL.NoErrorClass,
            durationMs,
        );
        this.incrementEndpointEvent(
            RPC_OBSERVABILITY_EVENT.AttemptSucceeded,
            context.method,
            endpoint,
        );
    }

    recordEndpointAttemptFailure(
        context: RpcEndpointAttemptContext,
        endpoint: RpcEndpointSnapshot,
        error: unknown,
    ): void {
        const durationMs = elapsedMs(context.attemptStartedAtMs);
        const errorClass = errorClassName(error);
        this.recordEndpointWeightGauges(endpoint);
        this.log.warn(RPC_OBSERVABILITY_LOG_MESSAGE.EndpointAttemptFailed, {
            ...this.baseLogFields(
                RPC_OBSERVABILITY_LOG_ACTION.EndpointAttemptFailed,
                context.method,
            ),
            ...this.endpointLogFields(endpoint),
            ...errorLogFields(error),
            attempt: context.attempt,
            durationMs,
        });
        this.recordEndpointAttemptMetric(
            context.method,
            endpoint,
            RPC_OBSERVABILITY_RESULT.Failure,
            errorClass,
            durationMs,
        );
        this.incrementEndpointEvent(
            RPC_OBSERVABILITY_EVENT.AttemptFailed,
            context.method,
            endpoint,
            RPC_OBSERVABILITY_RESULT.Failure,
            errorClass,
        );
    }

    recordCallSuccess(
        call: RpcCallContext,
        endpoint: RpcEndpointSnapshot,
    ): void {
        const durationMs = elapsedMs(call.startedAtMs);
        this.log.debug(RPC_OBSERVABILITY_LOG_MESSAGE.CallSucceeded, {
            ...this.baseLogFields(
                RPC_OBSERVABILITY_LOG_ACTION.CallSucceeded,
                call.method,
            ),
            ...this.endpointLogFields(endpoint),
            durationMs,
        });
        this.recordCallMetric(
            call.method,
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
        this.log.warn(RPC_OBSERVABILITY_LOG_MESSAGE.CallFailed, {
            ...this.baseLogFields(
                RPC_OBSERVABILITY_LOG_ACTION.CallFailed,
                call.method,
            ),
            ...(endpoint ? this.endpointLogFields(endpoint) : {}),
            ...errorLogFields(error),
            durationMs,
        });
        this.recordCallMetric(
            call.method,
            endpoint,
            RPC_OBSERVABILITY_RESULT.Failure,
            errorClass,
            durationMs,
        );
    }

    recordRetryScheduled(input: RpcRetryScheduledInput): void {
        this.log.warn(RPC_OBSERVABILITY_LOG_MESSAGE.RetryScheduled, {
            ...this.baseLogFields(
                RPC_OBSERVABILITY_LOG_ACTION.RetryScheduled,
                input.method,
            ),
            ...this.endpointLogFields(input.endpoint),
            attempt: input.attempt,
            nextAttempt: input.nextAttempt,
            delayMs: input.delayMs,
        });
        this.metrics?.increment(RPC_OBSERVABILITY_METRIC.RetryAttempt, 1, {
            ...this.baseMetricLabels(input.method, input.endpoint),
            attempt: input.attempt,
            next_attempt: input.nextAttempt,
        });
        this.incrementEndpointEvent(
            RPC_OBSERVABILITY_EVENT.RetryScheduled,
            input.method,
            input.endpoint,
        );
    }

    recordRateLimitWait(input: RpcRateLimitWaitInput): void {
        this.log.debug(RPC_OBSERVABILITY_LOG_MESSAGE.RateLimiterWaited, {
            ...this.baseLogFields(
                RPC_OBSERVABILITY_LOG_ACTION.RateLimiterWaited,
                input.method,
            ),
            ...this.endpointLogFields(input.endpoint),
            waitedMs: input.waitedMs,
        });
        this.metrics?.histogram(
            RPC_OBSERVABILITY_METRIC.RateLimiterWaitMs,
            input.waitedMs,
            {
                ...this.baseMetricLabels(input.method, input.endpoint),
            },
        );
        this.incrementEndpointEvent(
            RPC_OBSERVABILITY_EVENT.RateLimiterWaited,
            input.method,
            input.endpoint,
        );
    }

    recordCircuitOpen(
        method: string,
        endpoint: RpcEndpointSnapshot,
        error: unknown,
    ): void {
        this.log.warn(RPC_OBSERVABILITY_LOG_MESSAGE.CircuitOpen, {
            ...this.baseLogFields(
                RPC_OBSERVABILITY_LOG_ACTION.CircuitOpen,
                method,
            ),
            ...this.endpointLogFields(endpoint),
            ...errorLogFields(error),
        });
        this.metrics?.increment(RPC_OBSERVABILITY_METRIC.CircuitOpen, 1, {
            ...this.baseMetricLabels(method, endpoint),
            error_class: errorClassName(error),
        });
        this.incrementEndpointEvent(
            RPC_OBSERVABILITY_EVENT.CircuitOpen,
            method,
            endpoint,
            RPC_OBSERVABILITY_RESULT.Failure,
            errorClassName(error),
        );
    }

    recordEndpointEvent(input: RpcEndpointEventInput): void {
        const level = input.level ?? DEFAULT_RPC_ENDPOINT_EVENT_LOG_LEVEL;
        this.log[level](
            input.message ?? RPC_OBSERVABILITY_LOG_MESSAGE.EndpointEvent,
            {
                ...this.baseLogFields(input.event, input.method),
                ...this.endpointLogFields(input.endpoint),
                ...(input.extra ?? {}),
            },
        );
        this.recordEndpointWeightGauges(input.endpoint);
        this.incrementEndpointEvent(input.event, input.method, input.endpoint);
    }

    private recordCallMetric(
        method: string,
        endpoint: RpcEndpointSnapshot | null,
        result: RpcObservabilityResult,
        errorClass: string,
        durationMs: number,
    ): void {
        const labels = this.baseMetricLabels(
            method,
            endpoint,
            result,
            errorClass,
        );
        this.metrics?.increment(RPC_OBSERVABILITY_METRIC.Call, 1, labels);
        this.metrics?.histogram(
            RPC_OBSERVABILITY_METRIC.CallDurationMs,
            durationMs,
            labels,
        );
    }

    private recordEndpointAttemptMetric(
        method: string,
        endpoint: RpcEndpointSnapshot,
        result: RpcObservabilityResult,
        errorClass: string,
        durationMs: number,
    ): void {
        const labels = this.baseMetricLabels(
            method,
            endpoint,
            result,
            errorClass,
        );
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

    private incrementEndpointEvent(
        event: RpcObservabilityEvent,
        method: string,
        endpoint: RpcEndpointSnapshot | null,
        result: RpcObservabilityResult = RPC_OBSERVABILITY_RESULT.None,
        errorClass: string = RPC_OBSERVABILITY_SENTINEL.NoErrorClass,
    ): void {
        this.metrics?.increment(RPC_OBSERVABILITY_METRIC.EndpointEvent, 1, {
            ...this.baseMetricLabels(method, endpoint, result, errorClass),
            event,
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

    private baseMetricLabels(
        method: string,
        endpoint: RpcEndpointSnapshot | null,
        result: RpcObservabilityResult = RPC_OBSERVABILITY_RESULT.None,
        errorClass: string = RPC_OBSERVABILITY_SENTINEL.NoErrorClass,
    ): Record<string, string | number> {
        return {
            component: this.config.component,
            protocol: this.config.protocol,
            method,
            endpoint: endpoint?.id ?? RPC_OBSERVABILITY_SENTINEL.NoEndpoint,
            result,
            error_class: errorClass,
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
}

export function errorClassName(error: unknown): string {
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
