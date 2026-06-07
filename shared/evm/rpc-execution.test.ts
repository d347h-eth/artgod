import { describe, expect, it } from "vitest";
import { WeightedEndpointSelector } from "../config/weighted-endpoints.js";
import type { MetricLabels, Metrics } from "../observability/metrics/types.js";
import {
    RPC_OBSERVABILITY_METRIC,
    RPC_OBSERVABILITY_RESULT,
    RPC_OBSERVABILITY_SENTINEL,
    RPC_OBSERVABILITY_WORKSPACE,
    RPC_PROTOCOL,
    RpcObservability,
} from "../observability/rpc.js";
import {
    CircuitBreaker,
    CircuitOpenError,
    TokenBucketRateLimiter,
} from "./rpc-resilience.js";
import {
    executeObservedRpcEndpointCall,
    startObservedRpcEndpointAttempt,
} from "./rpc-execution.js";

type TestEndpointValue = {
    url: string;
    circuitBreaker?: CircuitBreaker;
    rateLimiter?: TokenBucketRateLimiter;
};

const TEST_RPC_ENDPOINT_ID_PREFIX = "test-rpc";
const TEST_RPC_ENDPOINT_A_ID = `${TEST_RPC_ENDPOINT_ID_PREFIX}-1`;
const TEST_RPC_ENDPOINT_B_ID = `${TEST_RPC_ENDPOINT_ID_PREFIX}-2`;
const TEST_RPC_ENDPOINT_A_URL = "https://rpc-a.example";
const TEST_RPC_ENDPOINT_B_URL = "https://rpc-b.example";
const TEST_RPC_METHOD = "eth_call";
const TEST_RPC_COMPONENT = "test-rpc-executor";
const TEST_RPC_LOG_COMPONENT = "TestRpcExecutor";
const TEST_RPC_RESULT = "0x1";
const TEST_RPC_FAILURE_MESSAGE = "rpc unavailable";
const TEST_RETRY_POLICY = {
    maxAttempts: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
};
const TEST_RATE_LIMIT_CONFIG = {
    requestsPerSecond: 1,
    burst: 1,
};
const TEST_CIRCUIT_BREAKER_CONFIG = {
    failureThreshold: 1,
    openMs: 10_000,
    halfOpenMaxRequests: 1,
};
const TEST_RATE_LIMIT_WAIT_MS = 1_000;

const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};

class CapturingMetrics implements Metrics {
    readonly increments: Array<{
        name: string;
        value?: number;
        labels?: MetricLabels;
    }> = [];
    readonly gauges: Array<{
        name: string;
        value: number;
        labels?: MetricLabels;
    }> = [];
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

describe("executeObservedRpcEndpointCall", () => {
    it("records failed attempts, retry scheduling, and final call success", async () => {
        const metrics = new CapturingMetrics();
        const observer = createTestRpcObservability(metrics);
        const selector = createTestSelector([
            { url: TEST_RPC_ENDPOINT_A_URL },
            { url: TEST_RPC_ENDPOINT_B_URL },
        ]);
        const attemptedUrls: string[] = [];

        const result = await executeObservedRpcEndpointCall({
            selector,
            method: TEST_RPC_METHOD,
            rpcObservability: observer,
            retryPolicy: TEST_RETRY_POLICY,
            sleep: async () => {},
            execute: async (endpoint) => {
                attemptedUrls.push(endpoint.value.url);
                if (endpoint.value.url === TEST_RPC_ENDPOINT_A_URL) {
                    throw new Error(TEST_RPC_FAILURE_MESSAGE);
                }
                return TEST_RPC_RESULT;
            },
        });

        expect(result).toBe(TEST_RPC_RESULT);
        expect(attemptedUrls).toEqual([
            TEST_RPC_ENDPOINT_A_URL,
            TEST_RPC_ENDPOINT_B_URL,
        ]);
        expect(metrics.increments).toContainEqual({
            name: RPC_OBSERVABILITY_METRIC.RetryAttempt,
            value: 1,
            labels: {
                component: TEST_RPC_COMPONENT,
                protocol: RPC_PROTOCOL.Http,
                method: TEST_RPC_METHOD,
                endpoint: TEST_RPC_ENDPOINT_A_ID,
                result: RPC_OBSERVABILITY_RESULT.None,
                error_class: RPC_OBSERVABILITY_SENTINEL.NoErrorClass,
                attempt: 1,
                next_attempt: 2,
            },
        });
        expect(metrics.increments).toContainEqual({
            name: RPC_OBSERVABILITY_METRIC.EndpointAttempt,
            value: 1,
            labels: {
                component: TEST_RPC_COMPONENT,
                protocol: RPC_PROTOCOL.Http,
                method: TEST_RPC_METHOD,
                endpoint: TEST_RPC_ENDPOINT_A_ID,
                result: RPC_OBSERVABILITY_RESULT.Failure,
                error_class: Error.name,
            },
        });
        expect(metrics.increments).toContainEqual({
            name: RPC_OBSERVABILITY_METRIC.Call,
            value: 1,
            labels: {
                component: TEST_RPC_COMPONENT,
                protocol: RPC_PROTOCOL.Http,
                method: TEST_RPC_METHOD,
                endpoint: TEST_RPC_ENDPOINT_B_ID,
                result: RPC_OBSERVABILITY_RESULT.Success,
                error_class: RPC_OBSERVABILITY_SENTINEL.NoErrorClass,
            },
        });
    });

    it("records rate-limit waits", async () => {
        const metrics = new CapturingMetrics();
        const observer = createTestRpcObservability(metrics);
        let nowMs = 0;
        const rateLimiter = new TokenBucketRateLimiter(
            TEST_RATE_LIMIT_CONFIG,
            () => nowMs,
            async (ms) => {
                nowMs += ms;
            },
        );
        await rateLimiter.acquire();
        const selector = createTestSelector([
            { url: TEST_RPC_ENDPOINT_A_URL, rateLimiter },
        ]);

        await expect(
            executeObservedRpcEndpointCall({
                selector,
                method: TEST_RPC_METHOD,
                rpcObservability: observer,
                rateLimiter: (endpoint) => endpoint.value.rateLimiter,
                execute: async () => TEST_RPC_RESULT,
            }),
        ).resolves.toBe(TEST_RPC_RESULT);

        expect(metrics.histograms).toContainEqual({
            name: RPC_OBSERVABILITY_METRIC.RateLimiterWaitMs,
            value: TEST_RATE_LIMIT_WAIT_MS,
            labels: {
                component: TEST_RPC_COMPONENT,
                protocol: RPC_PROTOCOL.Http,
                method: TEST_RPC_METHOD,
                endpoint: TEST_RPC_ENDPOINT_A_ID,
                result: RPC_OBSERVABILITY_RESULT.None,
                error_class: RPC_OBSERVABILITY_SENTINEL.NoErrorClass,
            },
        });
    });

    it("records circuit-open events", async () => {
        const metrics = new CapturingMetrics();
        const observer = createTestRpcObservability(metrics);
        const circuitBreaker = new CircuitBreaker(
            TEST_CIRCUIT_BREAKER_CONFIG,
            () => 0,
        );
        const selector = createTestSelector([
            { url: TEST_RPC_ENDPOINT_A_URL, circuitBreaker },
        ]);

        await expect(
            executeObservedRpcEndpointCall({
                selector,
                method: TEST_RPC_METHOD,
                rpcObservability: observer,
                circuitBreaker: (endpoint) => endpoint.value.circuitBreaker,
                execute: async () => {
                    throw new Error(TEST_RPC_FAILURE_MESSAGE);
                },
            }),
        ).rejects.toThrow(TEST_RPC_FAILURE_MESSAGE);
        await expect(
            executeObservedRpcEndpointCall({
                selector,
                method: TEST_RPC_METHOD,
                rpcObservability: observer,
                circuitBreaker: (endpoint) => endpoint.value.circuitBreaker,
                execute: async () => TEST_RPC_RESULT,
            }),
        ).rejects.toBeInstanceOf(CircuitOpenError);

        expect(metrics.increments).toContainEqual({
            name: RPC_OBSERVABILITY_METRIC.CircuitOpen,
            value: 1,
            labels: {
                component: TEST_RPC_COMPONENT,
                protocol: RPC_PROTOCOL.Http,
                method: TEST_RPC_METHOD,
                endpoint: TEST_RPC_ENDPOINT_A_ID,
                result: RPC_OBSERVABILITY_RESULT.None,
                error_class: CircuitOpenError.name,
            },
        });
    });

    it("records single-attempt failures without scheduling retries", async () => {
        const metrics = new CapturingMetrics();
        const observer = createTestRpcObservability(metrics);
        const selector = createTestSelector([{ url: TEST_RPC_ENDPOINT_A_URL }]);
        let attemptCount = 0;

        await expect(
            executeObservedRpcEndpointCall({
                selector,
                method: TEST_RPC_METHOD,
                rpcObservability: observer,
                execute: async () => {
                    attemptCount += 1;
                    throw new Error(TEST_RPC_FAILURE_MESSAGE);
                },
            }),
        ).rejects.toThrow(TEST_RPC_FAILURE_MESSAGE);

        expect(attemptCount).toBe(1);
        expect(
            metrics.increments.some(
                (metric) =>
                    metric.name === RPC_OBSERVABILITY_METRIC.RetryAttempt,
            ),
        ).toBe(false);
        expect(metrics.increments).toContainEqual({
            name: RPC_OBSERVABILITY_METRIC.Call,
            value: 1,
            labels: {
                component: TEST_RPC_COMPONENT,
                protocol: RPC_PROTOCOL.Http,
                method: TEST_RPC_METHOD,
                endpoint: TEST_RPC_ENDPOINT_A_ID,
                result: RPC_OBSERVABILITY_RESULT.Failure,
                error_class: Error.name,
            },
        });
    });
});

describe("startObservedRpcEndpointAttempt", () => {
    it("records deferred attempts only once", () => {
        const metrics = new CapturingMetrics();
        const observer = createTestRpcObservability(metrics);
        const selector = createTestSelector([{ url: TEST_RPC_ENDPOINT_A_URL }]);
        const attempt = startObservedRpcEndpointAttempt({
            selector,
            method: TEST_RPC_METHOD,
            rpcObservability: observer,
        });

        const firstClose = attempt.recordSuccess();
        const secondClose = attempt.recordSuccess();
        const thirdClose = attempt.recordFailure(
            new Error(TEST_RPC_FAILURE_MESSAGE),
        );

        expect(firstClose).toEqual(secondClose);
        expect(firstClose).toEqual(thirdClose);
        expect(
            metrics.increments.filter(
                (metric) =>
                    metric.name === RPC_OBSERVABILITY_METRIC.EndpointAttempt,
            ),
        ).toHaveLength(1);
        expect(metrics.increments).toContainEqual({
            name: RPC_OBSERVABILITY_METRIC.Call,
            value: 1,
            labels: {
                component: TEST_RPC_COMPONENT,
                protocol: RPC_PROTOCOL.Http,
                method: TEST_RPC_METHOD,
                endpoint: TEST_RPC_ENDPOINT_A_ID,
                result: RPC_OBSERVABILITY_RESULT.Success,
                error_class: RPC_OBSERVABILITY_SENTINEL.NoErrorClass,
            },
        });
        expect(
            metrics.increments.some(
                (metric) =>
                    metric.name === RPC_OBSERVABILITY_METRIC.Call &&
                    metric.labels?.result === RPC_OBSERVABILITY_RESULT.Failure,
            ),
        ).toBe(false);
    });
});

function createTestRpcObservability(metrics: Metrics): RpcObservability {
    return new RpcObservability({
        workspace: RPC_OBSERVABILITY_WORKSPACE.Trading,
        component: TEST_RPC_COMPONENT,
        protocol: RPC_PROTOCOL.Http,
        metrics,
        logger: noopLogger,
        logComponent: TEST_RPC_LOG_COMPONENT,
    });
}

function createTestSelector(
    endpoints: TestEndpointValue[],
): WeightedEndpointSelector<TestEndpointValue> {
    return new WeightedEndpointSelector(
        endpoints.map((endpoint, index) => ({
            url: endpoint.url,
            weight: 1,
            id: `${TEST_RPC_ENDPOINT_ID_PREFIX}-${index + 1}`,
            value: endpoint,
        })),
    );
}
