import { describe, expect, it } from "vitest";
import { createPublicClient } from "viem";
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
    createResilientWeightedRpcTransport,
    createWeightedRpcTransport,
    EVM_STATE_CHANGING_RPC_METHOD,
    READ_ONLY_RPC_METHOD_REJECTED_ERROR,
} from "./weighted-rpc-transport.js";

const TEST_ENDPOINT_ID_PREFIX = "test-rpc";
const TEST_RPC_COMPONENT = "test-viem-rpc";
const TEST_RPC_ENDPOINT_ID = `${TEST_ENDPOINT_ID_PREFIX}-1`;
const TEST_RPC_ENDPOINT_URL = "https://rpc-a.example";
const TEST_SECOND_RPC_ENDPOINT_URL = "https://rpc-b.example";
const TEST_RPC_METHOD = "eth_blockNumber";
const TEST_RPC_LOG_COMPONENT = "TestRpc";
const TEST_RPC_RESULT = "0x1";
const TEST_RPC_UPSTREAM_ERROR_MESSAGE = "upstream unavailable";
const TEST_RPC_HTTP_ERROR_STATUS = 500;
const TEST_RPC_REQUEST_TIMEOUT_MS = 1_000;
const TEST_JSON_CONTENT_TYPE_HEADER = "content-type";
const TEST_JSON_CONTENT_TYPE = "application/json";
const TEST_RPC_RETRY_POLICY = {
    maxAttempts: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
};
const TEST_RPC_RESILIENCE = {
    requestTimeoutMs: TEST_RPC_REQUEST_TIMEOUT_MS,
    rateLimiter: {
        requestsPerSecond: 0,
        burst: 1,
    },
    circuitBreaker: {
        failureThreshold: 10,
        openMs: 1_000,
        halfOpenMaxRequests: 1,
    },
};

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

describe("createWeightedRpcTransport", () => {
    it("records failed requests and drifts the next request to another endpoint", async () => {
        const calls: string[] = [];
        const fetchFn: typeof fetch = async (input) => {
            const url = String(input);
            calls.push(url);
            if (calls.length === 1) {
                return new Response(
                    JSON.stringify({
                        id: 1,
                        error: {
                            code: -32000,
                            message: TEST_RPC_UPSTREAM_ERROR_MESSAGE,
                        },
                    }),
                    {
                        status: 200,
                        headers: {
                            [TEST_JSON_CONTENT_TYPE_HEADER]:
                                TEST_JSON_CONTENT_TYPE,
                        },
                    },
                );
            }
            return new Response(
                JSON.stringify({
                    id: 2,
                    result: TEST_RPC_RESULT,
                }),
                {
                    status: 200,
                    headers: {
                        [TEST_JSON_CONTENT_TYPE_HEADER]: TEST_JSON_CONTENT_TYPE,
                    },
                },
            );
        };
        const client = createPublicClient({
            transport: createWeightedRpcTransport(
                [
                    { url: TEST_RPC_ENDPOINT_URL, weight: 1 },
                    { url: TEST_SECOND_RPC_ENDPOINT_URL, weight: 1 },
                ],
                { fetchFn },
            ),
        });

        await expect(
            client.request({ method: TEST_RPC_METHOD }),
        ).rejects.toThrow(TEST_RPC_UPSTREAM_ERROR_MESSAGE);
        await expect(client.request({ method: TEST_RPC_METHOD })).resolves.toBe(
            TEST_RPC_RESULT,
        );

        expect(calls).toEqual([
            TEST_RPC_ENDPOINT_URL,
            TEST_SECOND_RPC_ENDPOINT_URL,
        ]);
    });

    it("does not apply viem retries to single-attempt weighted transport calls", async () => {
        const calls: string[] = [];
        const fetchFn: typeof fetch = async (input) => {
            calls.push(String(input));
            return new Response("", {
                status: TEST_RPC_HTTP_ERROR_STATUS,
            });
        };
        const client = createPublicClient({
            transport: createWeightedRpcTransport(
                [{ url: TEST_RPC_ENDPOINT_URL, weight: 1 }],
                { fetchFn },
            ),
        });

        await expect(
            client.request({ method: TEST_RPC_METHOD }),
        ).rejects.toThrow();

        expect(calls).toEqual([TEST_RPC_ENDPOINT_URL]);
    });

    it("emits shared RPC observability metrics for viem transport calls", async () => {
        const metrics = new CapturingMetrics();
        const observer = new RpcObservability({
            workspace: RPC_OBSERVABILITY_WORKSPACE.Trading,
            component: TEST_RPC_COMPONENT,
            protocol: RPC_PROTOCOL.Http,
            metrics,
            logger: noopLogger,
            logComponent: TEST_RPC_LOG_COMPONENT,
        });
        const fetchFn: typeof fetch = async () =>
            new Response(
                JSON.stringify({
                    id: 1,
                    result: TEST_RPC_RESULT,
                }),
                {
                    status: 200,
                    headers: {
                        [TEST_JSON_CONTENT_TYPE_HEADER]: TEST_JSON_CONTENT_TYPE,
                    },
                },
            );
        const client = createPublicClient({
            transport: createWeightedRpcTransport(
                [{ url: TEST_RPC_ENDPOINT_URL, weight: 2 }],
                {
                    endpointIdPrefix: TEST_ENDPOINT_ID_PREFIX,
                    fetchFn,
                    rpcObservability: observer,
                },
            ),
        });

        await expect(client.request({ method: TEST_RPC_METHOD })).resolves.toBe(
            TEST_RPC_RESULT,
        );

        expect(metrics.gauges).toContainEqual({
            name: RPC_OBSERVABILITY_METRIC.EndpointConfiguredWeight,
            value: 2,
            labels: {
                component: TEST_RPC_COMPONENT,
                protocol: RPC_PROTOCOL.Http,
                endpoint: TEST_RPC_ENDPOINT_ID,
            },
        });
        expect(metrics.increments).toContainEqual({
            name: RPC_OBSERVABILITY_METRIC.EndpointAttempt,
            value: 1,
            labels: {
                component: TEST_RPC_COMPONENT,
                protocol: RPC_PROTOCOL.Http,
                method: TEST_RPC_METHOD,
                endpoint: TEST_RPC_ENDPOINT_ID,
                result: RPC_OBSERVABILITY_RESULT.Success,
                error_class: RPC_OBSERVABILITY_SENTINEL.NoErrorClass,
            },
        });
        expect(metrics.increments).toContainEqual({
            name: RPC_OBSERVABILITY_METRIC.Call,
            value: 1,
            labels: {
                component: TEST_RPC_COMPONENT,
                protocol: RPC_PROTOCOL.Http,
                method: TEST_RPC_METHOD,
                endpoint: TEST_RPC_ENDPOINT_ID,
                result: RPC_OBSERVABILITY_RESULT.Success,
                error_class: RPC_OBSERVABILITY_SENTINEL.NoErrorClass,
            },
        });
    });
});

describe("createResilientWeightedRpcTransport", () => {
    it("retries eligible requests through the next weighted endpoint", async () => {
        const calls: string[] = [];
        const fetchFn: typeof fetch = async (input) => {
            calls.push(String(input));
            if (calls.length === 1) {
                return new Response(
                    JSON.stringify({
                        id: 1,
                        error: {
                            code: -32000,
                            message: TEST_RPC_UPSTREAM_ERROR_MESSAGE,
                        },
                    }),
                    {
                        status: 200,
                        headers: {
                            [TEST_JSON_CONTENT_TYPE_HEADER]:
                                TEST_JSON_CONTENT_TYPE,
                        },
                    },
                );
            }
            return new Response(
                JSON.stringify({
                    id: 2,
                    result: TEST_RPC_RESULT,
                }),
                {
                    status: 200,
                    headers: {
                        [TEST_JSON_CONTENT_TYPE_HEADER]: TEST_JSON_CONTENT_TYPE,
                    },
                },
            );
        };
        const client = createPublicClient({
            transport: createResilientWeightedRpcTransport(
                [
                    { url: TEST_RPC_ENDPOINT_URL, weight: 1 },
                    { url: TEST_SECOND_RPC_ENDPOINT_URL, weight: 1 },
                ],
                {
                    fetchFn,
                    resilience: TEST_RPC_RESILIENCE,
                    retryPolicy: TEST_RPC_RETRY_POLICY,
                    sleep: async () => {},
                },
            ),
        });

        await expect(client.request({ method: TEST_RPC_METHOD })).resolves.toBe(
            TEST_RPC_RESULT,
        );

        expect(calls).toEqual([
            TEST_RPC_ENDPOINT_URL,
            TEST_SECOND_RPC_ENDPOINT_URL,
        ]);
    });

    it("rejects state-changing methods before selecting an endpoint", async () => {
        const calls: string[] = [];
        const fetchFn: typeof fetch = async (input) => {
            calls.push(String(input));
            return new Response(
                JSON.stringify({
                    id: 1,
                    result: TEST_RPC_RESULT,
                }),
                {
                    status: 200,
                    headers: {
                        [TEST_JSON_CONTENT_TYPE_HEADER]: TEST_JSON_CONTENT_TYPE,
                    },
                },
            );
        };
        const client = createPublicClient({
            transport: createResilientWeightedRpcTransport(
                [{ url: TEST_RPC_ENDPOINT_URL, weight: 1 }],
                {
                    fetchFn,
                    resilience: TEST_RPC_RESILIENCE,
                    retryPolicy: TEST_RPC_RETRY_POLICY,
                    sleep: async () => {},
                },
            ),
        });

        await expect(
            client.request({
                method: EVM_STATE_CHANGING_RPC_METHOD.SendRawTransaction,
                params: ["0x"],
            }),
        ).rejects.toThrow(READ_ONLY_RPC_METHOD_REJECTED_ERROR);

        expect(calls).toEqual([]);
    });
});
