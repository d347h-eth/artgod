import { performance } from "node:perf_hooks";
import type {
    FastifyInstance,
    FastifyReply,
    FastifyRequest,
    RouteGenericInterface,
} from "fastify";
import {
    NOOP_APM,
    type ApmPort,
    type SpanAttributes,
} from "@artgod/shared/observability/apm";
import {
    ARTGOD_SPAN_ATTRIBUTE,
    ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME,
    sanitizeHttpRequestTarget,
} from "@artgod/shared/observability";
import { logger } from "@artgod/shared/utils/logger";
import {
    noopMetrics,
    type MetricLabels,
    type Metrics,
} from "@artgod/shared/observability/metrics";
import {
    getCurrentQueryCacheDebugEvents,
    getCurrentQueryCacheDebugSummary,
} from "../../utils/query-cache-debug.js";
import { extractQueryCacheDebugReplyHeaders } from "./response-headers.js";

export type BackendHttpObservability = {
    apm: ApmPort;
    metrics: Metrics;
    deploymentMode: string;
};

export type BackendRouteSpanAttributesResolver<
    Route extends RouteGenericInterface = RouteGenericInterface,
> = (request: FastifyRequest<Route>) => SpanAttributes;

export type BackendRouteMetadata<
    Route extends RouteGenericInterface = RouteGenericInterface,
> = {
    method: string;
    route: string;
    spanAttributes?: BackendRouteSpanAttributesResolver<Route>;
};

type ApiRouteHandler<Route extends RouteGenericInterface> = (
    request: FastifyRequest<Route>,
    reply: FastifyReply,
) => Promise<unknown> | unknown;

type RequestMetricsState = {
    startedAtMs: number;
    preHandlerAtMs: number | null;
    preSerializationAtMs: number | null;
    inflightLabels: MetricLabels | null;
};

const requestStates = new WeakMap<FastifyRequest, RequestMetricsState>();
const inflightByLabelKey = new Map<string, number>();
const BACKEND_API_LOG_COMPONENT = "BackendApi";
const BACKEND_QUERY_CACHE_RESPONSE_ACTION = "query_cache_response";

// Provides a no-op observability boundary for tests and disabled runtimes.
export function createNoopBackendHttpObservability(
    deploymentMode: string,
): BackendHttpObservability {
    return {
        apm: NOOP_APM,
        metrics: noopMetrics,
        deploymentMode,
    };
}

// Registers Fastify lifecycle metrics for API golden signals and request phases.
export function registerBackendHttpObservabilityHooks(
    app: FastifyInstance,
    observability: BackendHttpObservability,
): void {
    app.addHook("onRequest", (request, _reply, done) => {
        if (!shouldObserveRequest(request)) {
            done();
            return;
        }
        requestStates.set(request, {
            startedAtMs: performance.now(),
            preHandlerAtMs: null,
            preSerializationAtMs: null,
            inflightLabels: null,
        });
        done();
    });

    app.addHook("preHandler", (request, _reply, done) => {
        const state = requestStates.get(request);
        if (!state) {
            done();
            return;
        }
        const labels = createRequestLabels(request);
        state.preHandlerAtMs = performance.now();
        state.inflightLabels = labels;

        observability.metrics.histogram(
            "http.pre_handler.duration_ms",
            state.preHandlerAtMs - state.startedAtMs,
            labels,
        );
        updateInflight(observability.metrics, labels, 1);
        done();
    });

    app.addHook("preSerialization", (request, _reply, _payload, done) => {
        const state = requestStates.get(request);
        if (state) {
            state.preSerializationAtMs = performance.now();
        }
        done();
    });

    app.addHook("onError", (request, _reply, error, done) => {
        if (!requestStates.has(request)) {
            done();
            return;
        }
        observability.metrics.increment("http.request.errors", 1, {
            ...createRequestLabels(request),
            error_class: error?.name || "Error",
        });
        done();
    });

    app.addHook("onResponse", (request, reply, done) => {
        const state = requestStates.get(request);
        if (!state) {
            done();
            return;
        }
        const labels = {
            ...createRequestLabels(request),
            status_class: statusClass(reply.statusCode),
        };
        const endedAtMs = performance.now();

        observability.metrics.increment("http.requests", 1, labels);
        observability.metrics.histogram(
            "http.request.duration_ms",
            endedAtMs - state.startedAtMs,
            labels,
        );
        if (state.preSerializationAtMs !== null) {
            observability.metrics.histogram(
                "http.response_send.duration_ms",
                endedAtMs - state.preSerializationAtMs,
                labels,
            );
        }
        if (state.inflightLabels) {
            updateInflight(observability.metrics, state.inflightLabels, -1);
        }

        recordQueryCacheMetrics(observability.metrics, request);
        logQueryCacheResponse(request, reply);
        requestStates.delete(request);
        done();
    });
}

// Wraps route handlers in an APM span and records adapter/use-case duration.
export function observeRouteHandler<Route extends RouteGenericInterface>(
    observability: BackendHttpObservability,
    metadata: BackendRouteMetadata<Route>,
    handler: ApiRouteHandler<Route>,
): ApiRouteHandler<Route> {
    return async (request, reply) => {
        const startedAtMs = performance.now();
        const labels = routeLabels(metadata);
        const attributes: SpanAttributes = {
            "http.method": metadata.method,
            "http.route": metadata.route,
            [ARTGOD_SPAN_ATTRIBUTE.DeploymentMode]:
                observability.deploymentMode,
            ...metadata.spanAttributes?.(request),
        };

        try {
            return await observability.apm.withSpan(
                "backend.http.route",
                attributes,
                () => Promise.resolve(handler(request, reply)),
            );
        } finally {
            observability.metrics.histogram(
                "http.handler.duration_ms",
                performance.now() - startedAtMs,
                labels,
            );
        }
    };
}

function createRequestLabels(request: FastifyRequest): MetricLabels {
    return routeLabels({
        method: request.method,
        route: getRouteTemplate(request),
    });
}

function routeLabels(metadata: {
    method: string;
    route: string;
}): MetricLabels {
    return {
        method: metadata.method.toUpperCase(),
        route: metadata.route,
    };
}

function shouldObserveRequest(request: FastifyRequest): boolean {
    const url = request.raw.url ?? "";
    return url.startsWith("/api/") || url.startsWith("/health");
}

function getRouteTemplate(request: FastifyRequest): string {
    const routeOptions = request.routeOptions as { url?: string } | undefined;
    return routeOptions?.url ?? "unmatched";
}

function statusClass(statusCode: number): string {
    if (statusCode < 100) return "unknown";
    return `${Math.trunc(statusCode / 100)}xx`;
}

function recordQueryCacheMetrics(
    metrics: Metrics,
    request: FastifyRequest,
): void {
    const queryCacheDebug = getCurrentQueryCacheDebugSummary();
    if (!queryCacheDebug) return;

    metrics.increment("query_cache.requests", 1, {
        ...createRequestLabels(request),
        status: queryCacheDebug.status,
    });
    if (queryCacheDebug.ageMs !== null) {
        metrics.histogram("query_cache.age_ms", queryCacheDebug.ageMs, {
            ...createRequestLabels(request),
            status: queryCacheDebug.status,
        });
    }
    if (queryCacheDebug.ttlMs !== null) {
        metrics.histogram("query_cache.ttl_ms", queryCacheDebug.ttlMs, {
            ...createRequestLabels(request),
            status: queryCacheDebug.status,
        });
    }
}

function logQueryCacheResponse(
    request: FastifyRequest,
    reply: FastifyReply,
): void {
    const queryCacheDebug = getCurrentQueryCacheDebugSummary();
    const ssrBackendRequestId = getSsrBackendRequestId(request);
    if (!queryCacheDebug && !ssrBackendRequestId) return;

    const target = sanitizeHttpRequestTarget(request.raw.url ?? "");
    logger.info("Backend API query cache response", {
        component: BACKEND_API_LOG_COMPONENT,
        action: BACKEND_QUERY_CACHE_RESPONSE_ACTION,
        method: request.method,
        route: getRouteTemplate(request),
        path: target.path,
        queryKeys: target.queryKeys,
        queryParamCount: target.queryParamCount,
        redactedQueryParamCount: target.redactedQueryParamCount,
        statusCode: reply.statusCode,
        ssrBackendRequestId,
        queryCacheStatus: queryCacheDebug?.status ?? null,
        queryCacheAgeMs: queryCacheDebug?.ageMs ?? null,
        queryCacheTtlMs: queryCacheDebug?.ttlMs ?? null,
        queryCacheEventCount: queryCacheDebug?.eventCount ?? 0,
        queryCacheEvents: getCurrentQueryCacheDebugEvents(),
        responseHeaders: extractQueryCacheDebugReplyHeaders((headerName) =>
            reply.getHeader(headerName),
        ),
    });
}

function getSsrBackendRequestId(request: FastifyRequest): string | null {
    const value =
        request.headers[
            ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME.toLowerCase()
        ];
    if (typeof value === "string" && value.trim()) {
        return value.trim();
    }
    return null;
}

function updateInflight(
    metrics: Metrics,
    labels: MetricLabels,
    delta: number,
): void {
    const key = labelKey(labels);
    const next = Math.max(0, (inflightByLabelKey.get(key) ?? 0) + delta);
    if (next === 0) {
        inflightByLabelKey.delete(key);
    } else {
        inflightByLabelKey.set(key, next);
    }
    metrics.gauge("http.inflight.requests", next, labels);
}

function labelKey(labels: MetricLabels): string {
    return Object.entries(labels)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(",");
}
