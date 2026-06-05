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
import { createWeightedRpcTransport } from "./weighted-rpc-transport.js";

const TEST_ENDPOINT_ID_PREFIX = "trading-rpc";
const TEST_RPC_COMPONENT = "bidding-viem-rpc";
const TEST_RPC_ENDPOINT_ID = `${TEST_ENDPOINT_ID_PREFIX}-1`;
const TEST_RPC_ENDPOINT_URL = "https://rpc-a.example";
const TEST_RPC_METHOD = "eth_blockNumber";
const TEST_RPC_LOG_COMPONENT = "TradingRpc";
const TEST_RPC_RESULT = "0x1";

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
                            message: "upstream unavailable",
                        },
                    }),
                    {
                        status: 200,
                        headers: { "content-type": "application/json" },
                    },
                );
            }
            return new Response(
                JSON.stringify({
                    id: 2,
                    result: "0x1",
                }),
                {
                    status: 200,
                    headers: { "content-type": "application/json" },
                },
            );
        };
        const client = createPublicClient({
            transport: createWeightedRpcTransport(
                [
                    { url: "https://rpc-a.example", weight: 1 },
                    { url: "https://rpc-b.example", weight: 1 },
                ],
                { fetchFn },
            ),
        });

        await expect(
            client.request({ method: "eth_blockNumber" }),
        ).rejects.toThrow("upstream unavailable");
        await expect(
            client.request({ method: "eth_blockNumber" }),
        ).resolves.toBe("0x1");

        expect(calls).toEqual([
            "https://rpc-a.example",
            "https://rpc-b.example",
        ]);
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
                    headers: { "content-type": "application/json" },
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

        await expect(
            client.request({ method: TEST_RPC_METHOD }),
        ).resolves.toBe(TEST_RPC_RESULT);

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
