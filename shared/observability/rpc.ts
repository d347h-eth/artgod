import { logger as defaultLogger, type LogLevel } from "../utils/logger.js";
import type { Metrics } from "./metrics/types.js";

export type RpcProtocol = "http" | "websocket";

export type RpcEndpointSnapshot = {
    id: string;
    url: string;
    configuredWeight: number;
    effectiveWeight: number;
};

export type RpcObservabilityConfig = {
    workspace: "backend" | "indexer";
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
    event: string;
    method: string;
    endpoint: RpcEndpointSnapshot;
    level?: LogLevel;
    message?: string;
    extra?: Record<string, unknown>;
};

const NO_ERROR_CLASS = "none";
const NO_ENDPOINT = "none";

// RpcObservability centralizes JSON-RPC logs and matching low-cardinality metrics.
export class RpcObservability {
    private readonly metrics?: Metrics;
    private readonly log: typeof defaultLogger;
    private readonly logComponent: string;

    constructor(private readonly config: RpcObservabilityConfig) {
        this.metrics = config.metrics;
        this.log = config.logger ?? defaultLogger;
        this.logComponent = config.logComponent ?? "RpcAdapter";
    }

    recordConfiguredEndpoint(endpoint: RpcEndpointSnapshot): void {
        this.recordEndpointWeightGauges(endpoint);
        this.recordEndpointEvent({
            event: "configured",
            method: "none",
            endpoint,
            message: "RPC endpoint configured",
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
        this.log.debug("RPC endpoint attempt started", {
            ...this.baseLogFields("endpoint_attempt_started", call.method),
            ...this.endpointLogFields(endpoint),
            attempt,
        });
        this.incrementEndpointEvent("attempt_started", call.method, endpoint);
        return context;
    }

    recordEndpointAttemptSuccess(
        context: RpcEndpointAttemptContext,
        endpoint: RpcEndpointSnapshot,
    ): void {
        const durationMs = elapsedMs(context.attemptStartedAtMs);
        this.recordEndpointWeightGauges(endpoint);
        this.log.debug("RPC endpoint attempt succeeded", {
            ...this.baseLogFields("endpoint_attempt_succeeded", context.method),
            ...this.endpointLogFields(endpoint),
            attempt: context.attempt,
            durationMs,
        });
        this.recordEndpointAttemptMetric(
            context.method,
            endpoint,
            "success",
            NO_ERROR_CLASS,
            durationMs,
        );
        this.incrementEndpointEvent("attempt_succeeded", context.method, endpoint);
    }

    recordEndpointAttemptFailure(
        context: RpcEndpointAttemptContext,
        endpoint: RpcEndpointSnapshot,
        error: unknown,
    ): void {
        const durationMs = elapsedMs(context.attemptStartedAtMs);
        const errorClass = errorClassName(error);
        this.recordEndpointWeightGauges(endpoint);
        this.log.warn("RPC endpoint attempt failed", {
            ...this.baseLogFields("endpoint_attempt_failed", context.method),
            ...this.endpointLogFields(endpoint),
            ...errorLogFields(error),
            attempt: context.attempt,
            durationMs,
        });
        this.recordEndpointAttemptMetric(
            context.method,
            endpoint,
            "failure",
            errorClass,
            durationMs,
        );
        this.incrementEndpointEvent(
            "attempt_failed",
            context.method,
            endpoint,
            "failure",
            errorClass,
        );
    }

    recordCallSuccess(
        call: RpcCallContext,
        endpoint: RpcEndpointSnapshot,
    ): void {
        const durationMs = elapsedMs(call.startedAtMs);
        this.log.debug("RPC call succeeded", {
            ...this.baseLogFields("call_succeeded", call.method),
            ...this.endpointLogFields(endpoint),
            durationMs,
        });
        this.recordCallMetric(
            call.method,
            endpoint,
            "success",
            NO_ERROR_CLASS,
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
        this.log.warn("RPC call failed", {
            ...this.baseLogFields("call_failed", call.method),
            ...(endpoint ? this.endpointLogFields(endpoint) : {}),
            ...errorLogFields(error),
            durationMs,
        });
        this.recordCallMetric(
            call.method,
            endpoint,
            "failure",
            errorClass,
            durationMs,
        );
    }

    recordRetryScheduled(input: RpcRetryScheduledInput): void {
        this.log.warn("RPC retry scheduled", {
            ...this.baseLogFields("retry_scheduled", input.method),
            ...this.endpointLogFields(input.endpoint),
            attempt: input.attempt,
            nextAttempt: input.nextAttempt,
            delayMs: input.delayMs,
        });
        this.metrics?.increment("rpc.retry.attempt", 1, {
            ...this.baseMetricLabels(input.method, input.endpoint),
            attempt: input.attempt,
            next_attempt: input.nextAttempt,
        });
        this.incrementEndpointEvent("retry_scheduled", input.method, input.endpoint);
    }

    recordRateLimitWait(input: RpcRateLimitWaitInput): void {
        this.log.debug("RPC rate limiter waited", {
            ...this.baseLogFields("rate_limiter_waited", input.method),
            ...this.endpointLogFields(input.endpoint),
            waitedMs: input.waitedMs,
        });
        this.metrics?.histogram("rpc.rate_limiter.wait_ms", input.waitedMs, {
            ...this.baseMetricLabels(input.method, input.endpoint),
        });
        this.incrementEndpointEvent(
            "rate_limiter_waited",
            input.method,
            input.endpoint,
        );
    }

    recordCircuitOpen(
        method: string,
        endpoint: RpcEndpointSnapshot,
        error: unknown,
    ): void {
        this.log.warn("RPC circuit open", {
            ...this.baseLogFields("circuit_open", method),
            ...this.endpointLogFields(endpoint),
            ...errorLogFields(error),
        });
        this.metrics?.increment("rpc.circuit_open", 1, {
            ...this.baseMetricLabels(method, endpoint),
            error_class: errorClassName(error),
        });
        this.incrementEndpointEvent(
            "circuit_open",
            method,
            endpoint,
            "failure",
            errorClassName(error),
        );
    }

    recordEndpointEvent(input: RpcEndpointEventInput): void {
        const level = input.level ?? "debug";
        this.log[level](input.message ?? "RPC endpoint event", {
            ...this.baseLogFields(input.event, input.method),
            ...this.endpointLogFields(input.endpoint),
            ...(input.extra ?? {}),
        });
        this.recordEndpointWeightGauges(input.endpoint);
        this.incrementEndpointEvent(input.event, input.method, input.endpoint);
    }

    private recordCallMetric(
        method: string,
        endpoint: RpcEndpointSnapshot | null,
        result: "success" | "failure",
        errorClass: string,
        durationMs: number,
    ): void {
        const labels = this.baseMetricLabels(method, endpoint, result, errorClass);
        this.metrics?.increment("rpc.call", 1, labels);
        this.metrics?.histogram("rpc.call.duration_ms", durationMs, labels);
    }

    private recordEndpointAttemptMetric(
        method: string,
        endpoint: RpcEndpointSnapshot,
        result: "success" | "failure",
        errorClass: string,
        durationMs: number,
    ): void {
        const labels = this.baseMetricLabels(method, endpoint, result, errorClass);
        this.metrics?.increment("rpc.endpoint.attempt", 1, labels);
        this.metrics?.histogram(
            "rpc.endpoint.attempt.duration_ms",
            durationMs,
            labels,
        );
    }

    private incrementEndpointEvent(
        event: string,
        method: string,
        endpoint: RpcEndpointSnapshot | null,
        result = "none",
        errorClass = NO_ERROR_CLASS,
    ): void {
        this.metrics?.increment("rpc.endpoint.event", 1, {
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
            "rpc.endpoint.configured_weight",
            endpoint.configuredWeight,
            labels,
        );
        this.metrics?.gauge(
            "rpc.endpoint.effective_weight",
            endpoint.effectiveWeight,
            labels,
        );
    }

    private baseMetricLabels(
        method: string,
        endpoint: RpcEndpointSnapshot | null,
        result = "none",
        errorClass = NO_ERROR_CLASS,
    ): Record<string, string | number> {
        return {
            component: this.config.component,
            protocol: this.config.protocol,
            method,
            endpoint: endpoint?.id ?? NO_ENDPOINT,
            result,
            error_class: errorClass,
        };
    }

    private baseLogFields(action: string, method: string): Record<string, unknown> {
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
            ...(candidate.code !== undefined ? { errorCode: candidate.code } : {}),
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
        return "invalid-url";
    }
}

function sanitizeRpcErrorMessage(message: string): string {
    return message.replace(/(https?|wss?):\/\/[^\s)]+/g, (rawUrl) =>
        safeEndpointOrigin(rawUrl),
    );
}
