import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ARTGOD_SPAN_ATTRIBUTE,
    ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME,
    QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME,
    QUERY_CACHE_DEBUG_HEADER_NAME,
    QUERY_CACHE_DEBUG_STATUSES,
    QUERY_CACHE_DEBUG_TTL_HEADER_NAME,
} from "@artgod/shared/observability";
import type { ApmPort, SpanAttributes } from "@artgod/shared/observability/apm";
import type {
    MetricLabels,
    Metrics,
} from "@artgod/shared/observability/metrics";
import { logger } from "@artgod/shared/utils/logger";
import type { BackendSecurityConfig } from "../../config.js";
import {
    markCurrentQueryCacheBypass,
    markCurrentQueryCacheHit,
} from "../../utils/query-cache-debug.js";
import {
    observeRouteHandler,
    registerBackendHttpObservabilityHooks,
    type BackendHttpObservability,
} from "./observability.js";
import { registerApiResponseHeaders } from "./response-headers.js";

const CORS_EXPOSE_HEADERS_RESPONSE_HEADER = "access-control-expose-headers";

class CapturingMetrics implements Metrics {
    readonly increments: Array<{
        name: string;
        value: number | undefined;
        labels: MetricLabels | undefined;
    }> = [];
    readonly gauges: Array<{
        name: string;
        value: number;
        labels: MetricLabels | undefined;
    }> = [];
    readonly histograms: Array<{
        name: string;
        value: number;
        labels: MetricLabels | undefined;
    }> = [];

    increment(name: string, value?: number, labels?: MetricLabels): void {
        this.increments.push({ name, value, labels });
    }

    gauge(name: string, value: number, labels?: MetricLabels): void {
        this.gauges.push({ name, value, labels });
    }

    histogram(name: string, value: number, labels?: MetricLabels): void {
        this.histograms.push({ name, value, labels });
    }
}

class CapturingApm implements ApmPort {
    readonly spans: Array<{
        name: string;
        attributes: SpanAttributes;
    }> = [];

    async withSpan<T>(
        name: string,
        attributes: SpanAttributes,
        run: () => Promise<T>,
    ): Promise<T> {
        this.spans.push({ name, attributes });
        return run();
    }

    withSyncSpan<T>(name: string, attributes: SpanAttributes, run: () => T): T {
        this.spans.push({ name, attributes });
        return run();
    }
}

describe("backend http observability", () => {
    const apps: Array<{ close(): Promise<void> }> = [];

    afterEach(async () => {
        await Promise.all(apps.splice(0).map((app) => app.close()));
        vi.restoreAllMocks();
    });

    it("records successful request metrics and wraps route handlers in spans", async () => {
        const { app, apm, metrics, observability } = createObservedApp(apps);

        app.get(
            "/api/example",
            observeRouteHandler(
                observability,
                { method: "GET", route: "/api/example" },
                async () => ({ ok: true }),
            ),
        );

        const response = await app.inject({
            method: "GET",
            url: "/api/example",
        });

        expect(response.statusCode).toBe(200);
        expect(apm.spans).toEqual([
            {
                name: "backend.http.route",
                attributes: {
                    "http.method": "GET",
                    "http.route": "/api/example",
                    [ARTGOD_SPAN_ATTRIBUTE.DeploymentMode]: "standard",
                },
            },
        ]);
        expect(metrics.increments).toContainEqual({
            name: "http.requests",
            value: 1,
            labels: {
                method: "GET",
                route: "/api/example",
                status_class: "2xx",
            },
        });
        expect(metrics.gauges).toContainEqual({
            name: "http.inflight.requests",
            value: 0,
            labels: {
                method: "GET",
                route: "/api/example",
            },
        });
        expect(metrics.histograms.map((metric) => metric.name)).toEqual(
            expect.arrayContaining([
                "http.pre_handler.duration_ms",
                "http.handler.duration_ms",
                "http.request.duration_ms",
                "http.response_send.duration_ms",
            ]),
        );
    });

    it("records explicit 4xx and 5xx status classes without exceptions", async () => {
        const { app, metrics, observability } = createObservedApp(apps);

        app.get(
            "/api/forbidden",
            observeRouteHandler(
                observability,
                { method: "GET", route: "/api/forbidden" },
                async (_request, reply) => {
                    reply.code(403);
                    return { error: "forbidden" };
                },
            ),
        );
        app.get(
            "/api/unavailable",
            observeRouteHandler(
                observability,
                { method: "GET", route: "/api/unavailable" },
                async (_request, reply) => {
                    reply.code(503);
                    return { error: "unavailable" };
                },
            ),
        );

        const forbidden = await app.inject({
            method: "GET",
            url: "/api/forbidden",
        });
        const unavailable = await app.inject({
            method: "GET",
            url: "/api/unavailable",
        });

        expect(forbidden.statusCode).toBe(403);
        expect(unavailable.statusCode).toBe(503);
        expect(metrics.increments).toContainEqual({
            name: "http.requests",
            value: 1,
            labels: {
                method: "GET",
                route: "/api/forbidden",
                status_class: "4xx",
            },
        });
        expect(metrics.increments).toContainEqual({
            name: "http.requests",
            value: 1,
            labels: {
                method: "GET",
                route: "/api/unavailable",
                status_class: "5xx",
            },
        });
        expect(
            metrics.increments.some(
                (metric) => metric.name === "http.request.errors",
            ),
        ).toBe(false);
    });

    it("adds route-specific span attributes without adding metric label cardinality", async () => {
        const { app, apm, metrics, observability } = createObservedApp(apps);

        app.get(
            "/api/activity",
            observeRouteHandler(
                observability,
                {
                    method: "GET",
                    route: "/api/activity",
                    spanAttributes: (request) => ({
                        [ARTGOD_SPAN_ATTRIBUTE.ActivityCursorPresent]: new URL(
                            request.raw.url ?? "/",
                            "http://localhost",
                        ).searchParams.has("cursor"),
                    }),
                },
                async () => ({ ok: true }),
            ),
        );

        const response = await app.inject({
            method: "GET",
            url: "/api/activity?cursor=abc",
        });

        expect(response.statusCode).toBe(200);
        expect(apm.spans[0]).toEqual({
            name: "backend.http.route",
            attributes: {
                "http.method": "GET",
                "http.route": "/api/activity",
                [ARTGOD_SPAN_ATTRIBUTE.DeploymentMode]: "standard",
                [ARTGOD_SPAN_ATTRIBUTE.ActivityCursorPresent]: true,
            },
        });
        expect(metrics.increments).toContainEqual({
            name: "http.requests",
            value: 1,
            labels: {
                method: "GET",
                route: "/api/activity",
                status_class: "2xx",
            },
        });
    });

    it("records thrown handler errors and decrements inflight requests", async () => {
        const { app, metrics, observability } = createObservedApp(apps);

        app.get(
            "/api/crash",
            observeRouteHandler(
                observability,
                { method: "GET", route: "/api/crash" },
                async () => {
                    throw new Error("boom");
                },
            ),
        );

        const response = await app.inject({
            method: "GET",
            url: "/api/crash",
        });

        expect(response.statusCode).toBe(500);
        expect(metrics.increments).toContainEqual({
            name: "http.request.errors",
            value: 1,
            labels: {
                method: "GET",
                route: "/api/crash",
                error_class: "Error",
            },
        });
        expect(metrics.increments).toContainEqual({
            name: "http.requests",
            value: 1,
            labels: {
                method: "GET",
                route: "/api/crash",
                status_class: "5xx",
            },
        });
        expect(metrics.gauges).toContainEqual({
            name: "http.inflight.requests",
            value: 0,
            labels: {
                method: "GET",
                route: "/api/crash",
            },
        });
        expect(metrics.histograms.map((metric) => metric.name)).toContain(
            "http.handler.duration_ms",
        );
    });

    it("logs sanitized SSR cache diagnostics and actual response headers", async () => {
        const info = vi.spyOn(logger, "info").mockImplementation(() => {});
        const { app, observability } = createObservedApp(apps, {
            responseHeaders: true,
        });
        const now = Date.now();

        app.get(
            "/api/cache",
            observeRouteHandler(
                observability,
                { method: "GET", route: "/api/cache" },
                async () => {
                    markCurrentQueryCacheHit({
                        storedAt: now - 42,
                        ttlMs: 60_000,
                        now,
                    });
                    return { ok: true };
                },
            ),
        );

        const response = await app.inject({
            method: "GET",
            url: "/api/cache?collection=terraforms&owner=0xabc&0xsecret=value",
            headers: {
                [ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME]: "ssr-request-1",
            },
        });

        expect(response.statusCode).toBe(200);
        expect(
            response.headers[QUERY_CACHE_DEBUG_HEADER_NAME.toLowerCase()],
        ).toBe(QUERY_CACHE_DEBUG_STATUSES.Hit);
        expect(
            response.headers[QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME.toLowerCase()],
        ).toBe("1");
        expect(info).toHaveBeenCalledWith(
            "Backend API query cache response",
            expect.objectContaining({
                component: "BackendApi",
                action: "query_cache_response",
                method: "GET",
                route: "/api/cache",
                path: "/api/cache",
                queryKeys: ["collection", "owner"],
                queryParamCount: 3,
                redactedQueryParamCount: 1,
                statusCode: 200,
                ssrBackendRequestId: "ssr-request-1",
                queryCacheStatus: QUERY_CACHE_DEBUG_STATUSES.Hit,
                queryCacheAgeMs: 42,
                queryCacheTtlMs: 60_000,
                queryCacheEventCount: 1,
                responseHeaders: expect.objectContaining({
                    [QUERY_CACHE_DEBUG_HEADER_NAME]: QUERY_CACHE_DEBUG_STATUSES.Hit,
                    [QUERY_CACHE_DEBUG_TTL_HEADER_NAME]: "60000",
                    [QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME]: "1",
                }),
            }),
        );
        expect(info.mock.calls[0][1]).not.toMatchObject({
            url: expect.any(String),
        });
    });

    it("reports mixed cache events without defaulting cacheless SSR requests to bypass", async () => {
        const info = vi.spyOn(logger, "info").mockImplementation(() => {});
        const { app, observability } = createObservedApp(apps, {
            responseHeaders: true,
        });

        app.get(
            "/api/mixed",
            observeRouteHandler(
                observability,
                { method: "GET", route: "/api/mixed" },
                async () => {
                    markCurrentQueryCacheHit({
                        storedAt: Date.now() - 1,
                        ttlMs: 60_000,
                    });
                    markCurrentQueryCacheBypass();
                    return { ok: true };
                },
            ),
        );
        app.get(
            "/api/cacheless",
            observeRouteHandler(
                observability,
                { method: "GET", route: "/api/cacheless" },
                async () => ({ ok: true }),
            ),
        );

        const mixed = await app.inject({
            method: "GET",
            url: "/api/mixed",
        });
        const cacheless = await app.inject({
            method: "GET",
            url: "/api/cacheless",
            headers: {
                [ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME]: "ssr-request-2",
                origin: "http://127.0.0.1:42701",
            },
        });

        expect(
            mixed.headers[QUERY_CACHE_DEBUG_HEADER_NAME.toLowerCase()],
        ).toBe(QUERY_CACHE_DEBUG_STATUSES.Mixed);
        expect(
            mixed.headers[QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME.toLowerCase()],
        ).toBe("2");
        expect(
            cacheless.headers[QUERY_CACHE_DEBUG_HEADER_NAME.toLowerCase()],
        ).toBeUndefined();
        expect(cacheless.headers[CORS_EXPOSE_HEADERS_RESPONSE_HEADER]).toBeUndefined();
        expect(info).toHaveBeenCalledWith(
            "Backend API query cache response",
            expect.objectContaining({
                route: "/api/cacheless",
                ssrBackendRequestId: "ssr-request-2",
                queryCacheStatus: null,
                queryCacheEventCount: 0,
                responseHeaders: {},
            }),
        );
    });
});

function createObservedApp(
    apps: Array<{ close(): Promise<void> }>,
    options: { responseHeaders?: boolean } = {},
): {
    app: ReturnType<typeof Fastify>;
    metrics: CapturingMetrics;
    apm: CapturingApm;
    observability: BackendHttpObservability;
} {
    const app = Fastify({ logger: false });
    apps.push(app);

    const metrics = new CapturingMetrics();
    const apm = new CapturingApm();
    const observability = {
        apm,
        metrics,
        deploymentMode: "standard",
    } satisfies BackendHttpObservability;

    if (options.responseHeaders) {
        registerApiResponseHeaders(app, TEST_SECURITY_CONFIG);
    }
    registerBackendHttpObservabilityHooks(app, observability);
    return {
        app,
        metrics,
        apm,
        observability,
    };
}

const TEST_SECURITY_CONFIG: BackendSecurityConfig = {
    allowedHosts: ["127.0.0.1", "localhost"],
    allowedOrigins: ["http://127.0.0.1:42701"],
    csrfCookieSecure: false,
};
