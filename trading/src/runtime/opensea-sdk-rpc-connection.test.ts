import { strict as assert } from "node:assert";
import { describe, it } from "vitest";
import type {
    MetricLabels,
    Metrics,
} from "@artgod/shared/observability/metrics";
import {
    RPC_OBSERVABILITY_METRIC,
    RPC_OBSERVABILITY_RESULT,
    RPC_OBSERVABILITY_SENTINEL,
    RPC_OBSERVABILITY_WORKSPACE,
    RPC_PROTOCOL,
    RpcObservability,
} from "@artgod/shared/observability/rpc";
import { createOpenSeaSdkRpcConnection } from "./opensea-sdk-rpc-connection.js";

const TEST_ENDPOINT_ID_PREFIX = "opensea-sdk-rpc";
const TEST_RPC_COMPONENT = "bidding-opensea-sdk-rpc";
const TEST_RPC_ENDPOINT_A = "https://rpc-a.example";
const TEST_RPC_ENDPOINT_B = "https://rpc-b.example";
const TEST_RPC_METHOD = "eth_getTransactionByHash";
const TEST_RPC_LOG_COMPONENT = "TradingRpc";

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

describe("createOpenSeaSdkRpcConnection", () => {
    it("emits RPC success metrics through a FetchRequest-shaped connection", async () => {
        const metrics = new CapturingMetrics();
        const connection = createOpenSeaSdkRpcConnection(
            [{ url: TEST_RPC_ENDPOINT_A, weight: 2 }],
            {
                endpointIdPrefix: TEST_ENDPOINT_ID_PREFIX,
                fetchFn: async () =>
                    new Response(
                        JSON.stringify({
                            id: 1,
                            result: "0xtx",
                        }),
                        {
                            status: 200,
                            headers: { "content-type": "application/json" },
                        },
                    ),
                rpcObservability: createObserver(metrics),
            },
        );
        const request = connection.clone();
        request.body = JSON.stringify({
            id: 1,
            method: TEST_RPC_METHOD,
            params: [],
            jsonrpc: "2.0",
        });
        request.setHeader("content-type", "application/json");

        const response = await request.send();
        response.assertOk();

        assert.deepEqual(response.bodyJson, {
            id: 1,
            result: "0xtx",
        });
        assertMetric(metrics, RPC_OBSERVABILITY_METRIC.Call, {
            component: TEST_RPC_COMPONENT,
            protocol: RPC_PROTOCOL.Http,
            method: TEST_RPC_METHOD,
            endpoint: `${TEST_ENDPOINT_ID_PREFIX}-1`,
            result: RPC_OBSERVABILITY_RESULT.Success,
            error_class: RPC_OBSERVABILITY_SENTINEL.NoErrorClass,
        });
    });

    it("records JSON-RPC failures and drifts to the next endpoint", async () => {
        const metrics = new CapturingMetrics();
        const urls: string[] = [];
        const connection = createOpenSeaSdkRpcConnection(
            [
                { url: TEST_RPC_ENDPOINT_A, weight: 1 },
                { url: TEST_RPC_ENDPOINT_B, weight: 1 },
            ],
            {
                endpointIdPrefix: TEST_ENDPOINT_ID_PREFIX,
                fetchFn: async (input) => {
                    const url = String(input);
                    urls.push(url);
                    if (urls.length === 1) {
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
                                headers: {
                                    "content-type": "application/json",
                                },
                            },
                        );
                    }
                    return new Response(
                        JSON.stringify({
                            id: 2,
                            result: "0xtx",
                        }),
                        {
                            status: 200,
                            headers: { "content-type": "application/json" },
                        },
                    );
                },
                rpcObservability: createObserver(metrics),
            },
        );

        const failedRequest = connection.clone();
        failedRequest.body = JSON.stringify({
            id: 1,
            method: TEST_RPC_METHOD,
            params: [],
            jsonrpc: "2.0",
        });
        assert.deepEqual((await failedRequest.send()).bodyJson, {
            id: 1,
            error: {
                code: -32000,
                message: "upstream unavailable",
            },
        });

        const successfulRequest = connection.clone();
        successfulRequest.body = JSON.stringify({
            id: 2,
            method: TEST_RPC_METHOD,
            params: [],
            jsonrpc: "2.0",
        });
        assert.deepEqual((await successfulRequest.send()).bodyJson, {
            id: 2,
            result: "0xtx",
        });

        assert.deepEqual(urls, [TEST_RPC_ENDPOINT_A, TEST_RPC_ENDPOINT_B]);
        assertMetric(metrics, RPC_OBSERVABILITY_METRIC.Call, {
            component: TEST_RPC_COMPONENT,
            protocol: RPC_PROTOCOL.Http,
            method: TEST_RPC_METHOD,
            endpoint: `${TEST_ENDPOINT_ID_PREFIX}-1`,
            result: RPC_OBSERVABILITY_RESULT.Failure,
            error_class: "OpenSeaSdkJsonRpcError",
        });
    });
});

function createObserver(metrics: Metrics): RpcObservability {
    return new RpcObservability({
        workspace: RPC_OBSERVABILITY_WORKSPACE.Trading,
        component: TEST_RPC_COMPONENT,
        protocol: RPC_PROTOCOL.Http,
        metrics,
        logger: noopLogger,
        logComponent: TEST_RPC_LOG_COMPONENT,
    });
}

function assertMetric(
    metrics: CapturingMetrics,
    name: string,
    labels: MetricLabels,
): void {
    assert.ok(
        metrics.increments.some(
            (metric) =>
                metric.name === name &&
                metric.value === 1 &&
                JSON.stringify(metric.labels) === JSON.stringify(labels),
        ),
        `Missing metric ${name}`,
    );
}
