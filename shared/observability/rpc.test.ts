import { describe, expect, it } from "vitest";
import { RpcObservability } from "./rpc.js";
import type { MetricLabels, Metrics } from "./metrics/types.js";
import type { LogLevel } from "../utils/logger.js";

class CapturingMetrics implements Metrics {
    readonly increments: Array<{
        name: string;
        value?: number;
        labels?: MetricLabels;
    }> = [];
    readonly gauges: Array<{ name: string; value: number; labels?: MetricLabels }> =
        [];
    readonly histograms: Array<{
        name: string;
        value: number;
        labels?: MetricLabels;
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

describe("RpcObservability", () => {
    it("records mirrored RPC call logs and metrics without raw endpoint URLs", () => {
        const metrics = new CapturingMetrics();
        const logs: Array<{
            level: LogLevel;
            message: string;
            meta?: Record<string, unknown>;
        }> = [];
        const logger = {
            debug: (message: string, meta?: Record<string, unknown>) =>
                logs.push({ level: "debug", message, meta }),
            info: (message: string, meta?: Record<string, unknown>) =>
                logs.push({ level: "info", message, meta }),
            warn: (message: string, meta?: Record<string, unknown>) =>
                logs.push({ level: "warn", message, meta }),
            error: (message: string, meta?: Record<string, unknown>) =>
                logs.push({ level: "error", message, meta }),
        };
        const observer = new RpcObservability({
            workspace: "indexer",
            component: "primary-http-rpc",
            protocol: "http",
            metrics,
            logger,
            logComponent: "TestRpc",
        });
        const endpoint = {
            id: "primary-rpc-1",
            url: "https://user:secret@rpc.example/api-key?token=secret",
            configuredWeight: 2,
            effectiveWeight: 1,
        };

        observer.recordConfiguredEndpoint(endpoint);
        const call = observer.startCall("getBlock");
        const attempt = observer.startEndpointAttempt(call, endpoint, 1);
        const error = new Error(
            "HTTP request failed URL: https://user:secret@rpc.example/api-key?token=secret",
        );
        observer.recordEndpointAttemptFailure(attempt, endpoint, error);
        observer.recordRetryScheduled({
            method: "getBlock",
            endpoint,
            attempt: 1,
            nextAttempt: 2,
            delayMs: 25,
        });
        observer.recordCallFailure(call, endpoint, error);

        expect(metrics.increments).toContainEqual({
            name: "rpc.endpoint.attempt",
            value: 1,
            labels: {
                component: "primary-http-rpc",
                protocol: "http",
                method: "getBlock",
                endpoint: "primary-rpc-1",
                result: "failure",
                error_class: "Error",
            },
        });
        expect(metrics.increments).toContainEqual({
            name: "rpc.call",
            value: 1,
            labels: {
                component: "primary-http-rpc",
                protocol: "http",
                method: "getBlock",
                endpoint: "primary-rpc-1",
                result: "failure",
                error_class: "Error",
            },
        });
        expect(metrics.increments).toContainEqual({
            name: "rpc.retry.attempt",
            value: 1,
            labels: {
                component: "primary-http-rpc",
                protocol: "http",
                method: "getBlock",
                endpoint: "primary-rpc-1",
                result: "none",
                error_class: "none",
                attempt: 1,
                next_attempt: 2,
            },
        });
        expect(metrics.gauges).toContainEqual({
            name: "rpc.endpoint.effective_weight",
            value: 1,
            labels: {
                component: "primary-http-rpc",
                protocol: "http",
                endpoint: "primary-rpc-1",
            },
        });
        const serializedLogs = JSON.stringify(logs);
        expect(serializedLogs).toContain("https://rpc.example");
        expect(serializedLogs).not.toContain("api-key");
        expect(serializedLogs).not.toContain("secret");
    });
});
