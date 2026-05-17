import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { ARTGOD_SPAN_ATTRIBUTE } from "@artgod/shared/observability";
import type { ApmPort, SpanAttributes } from "@artgod/shared/observability/apm";
import type {
    MetricLabels,
    Metrics,
} from "@artgod/shared/observability/metrics";
import {
    observeRouteHandler,
    registerBackendHttpObservabilityHooks,
    type BackendHttpObservability,
} from "./observability.js";

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
});

function createObservedApp(apps: Array<{ close(): Promise<void> }>): {
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

    registerBackendHttpObservabilityHooks(app, observability);
    return {
        app,
        metrics,
        apm,
        observability,
    };
}
