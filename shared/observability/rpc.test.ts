import { describe, expect, it } from "vitest";
import {
    errorClassName,
    errorLogFields,
    RPC_OBSERVABILITY_ERROR_CLASS,
    RPC_OBSERVABILITY_METRIC,
    RPC_OBSERVABILITY_RESULT,
    RPC_OBSERVABILITY_SENTINEL,
    RPC_OBSERVABILITY_WORKSPACE,
    RPC_PROTOCOL,
    RpcObservability,
} from "./rpc.js";
import type { MetricLabels, Metrics } from "./metrics/types.js";
import type { LogLevel } from "../utils/logger.js";
import {
    JSON_RPC_ERROR_CODE,
    RPC_PROVIDER_HEAD_LAG_ERROR_DATA,
} from "../evm/rpc-errors.js";

const TEST_RPC_COMPONENT = "primary-http-rpc";
const TEST_RPC_ENDPOINT_ID = "primary-rpc-1";
const TEST_RPC_ENDPOINT_URL =
    "https://user:secret@rpc.example/api-key?token=secret";
const TEST_RPC_ORIGIN = "https://rpc.example";
const TEST_RPC_METHOD = "getBlock";
const TEST_LOG_COMPONENT = "TestRpc";
const TEST_ERROR_CLASS = Error.name;
const TEST_PROVIDER_HTTP_ERROR_CLASS = "HttpRequestError";
const TEST_PROVIDER_TIMEOUT_ERROR_CLASS = "TimeoutError";
const TEST_PROVIDER_INVALID_PARAMS_ERROR_CLASS = "InvalidParamsRpcError";
const TEST_PROVIDER_RPC_REQUEST_ERROR_CLASS = "RpcRequestError";
const TEST_INVALID_PARAMS_MESSAGE = "invalid params";

class TestProviderTimeoutError extends Error {
    constructor() {
        super("The request timed out.");
        this.name = TEST_PROVIDER_TIMEOUT_ERROR_CLASS;
    }
}

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
            workspace: RPC_OBSERVABILITY_WORKSPACE.Indexer,
            component: TEST_RPC_COMPONENT,
            protocol: RPC_PROTOCOL.Http,
            metrics,
            logger,
            logComponent: TEST_LOG_COMPONENT,
        });
        const endpoint = {
            id: TEST_RPC_ENDPOINT_ID,
            url: TEST_RPC_ENDPOINT_URL,
            configuredWeight: 2,
            effectiveWeight: 1,
        };

        observer.recordConfiguredEndpoint(endpoint);
        const call = observer.startCall(TEST_RPC_METHOD);
        const attempt = observer.startEndpointAttempt(call, endpoint, 1);
        const error = new Error(
            `HTTP request failed URL: ${TEST_RPC_ENDPOINT_URL}`,
        );
        observer.recordEndpointAttemptFailure(attempt, endpoint, error);
        observer.recordRetryScheduled({
            method: TEST_RPC_METHOD,
            endpoint,
            attempt: 1,
            nextAttempt: 2,
            delayMs: 25,
        });
        observer.recordCallFailure(call, endpoint, error);

        expect(metrics.increments).toContainEqual({
            name: RPC_OBSERVABILITY_METRIC.EndpointAttempt,
            value: 1,
            labels: {
                component: TEST_RPC_COMPONENT,
                protocol: RPC_PROTOCOL.Http,
                method: TEST_RPC_METHOD,
                endpoint: TEST_RPC_ENDPOINT_ID,
                result: RPC_OBSERVABILITY_RESULT.Failure,
                error_class: TEST_ERROR_CLASS,
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
                result: RPC_OBSERVABILITY_RESULT.Failure,
                error_class: TEST_ERROR_CLASS,
            },
        });
        expect(metrics.increments).toContainEqual({
            name: RPC_OBSERVABILITY_METRIC.RetryAttempt,
            value: 1,
            labels: {
                component: TEST_RPC_COMPONENT,
                protocol: RPC_PROTOCOL.Http,
                method: TEST_RPC_METHOD,
                endpoint: TEST_RPC_ENDPOINT_ID,
                result: RPC_OBSERVABILITY_RESULT.None,
                error_class: RPC_OBSERVABILITY_SENTINEL.NoErrorClass,
                attempt: 1,
                next_attempt: 2,
            },
        });
        expect(metrics.gauges).toContainEqual({
            name: RPC_OBSERVABILITY_METRIC.EndpointEffectiveWeight,
            value: 1,
            labels: {
                component: TEST_RPC_COMPONENT,
                protocol: RPC_PROTOCOL.Http,
                endpoint: TEST_RPC_ENDPOINT_ID,
            },
        });
        const serializedLogs = JSON.stringify(logs);
        expect(serializedLogs).toContain(TEST_RPC_ORIGIN);
        expect(serializedLogs).not.toContain("api-key");
        expect(serializedLogs).not.toContain("secret");
    });

    it("normalizes provider timeout errors to the canonical RPC timeout class", () => {
        const directTimeout = new TestProviderTimeoutError();
        const wrappedTimeout = new Error("HTTP request failed") as Error & {
            cause: unknown;
        };
        wrappedTimeout.name = TEST_PROVIDER_HTTP_ERROR_CLASS;
        wrappedTimeout.cause = directTimeout;

        expect(errorClassName(directTimeout)).toBe(
            RPC_OBSERVABILITY_ERROR_CLASS.RequestTimeout,
        );
        expect(errorClassName(wrappedTimeout)).toBe(
            RPC_OBSERVABILITY_ERROR_CLASS.RequestTimeout,
        );
        expect(errorLogFields(wrappedTimeout)).toMatchObject({
            errorClass: RPC_OBSERVABILITY_ERROR_CLASS.RequestTimeout,
        });
    });

    it("normalizes provider head-lag errors to the canonical RPC class", () => {
        const cause = Object.assign(new Error(TEST_INVALID_PARAMS_MESSAGE), {
            name: TEST_PROVIDER_RPC_REQUEST_ERROR_CLASS,
            code: JSON_RPC_ERROR_CODE.InvalidParams,
            data: RPC_PROVIDER_HEAD_LAG_ERROR_DATA
                .FromBlockGreaterThanLatestBlock,
        });
        const error = Object.assign(new Error(TEST_INVALID_PARAMS_MESSAGE), {
            name: TEST_PROVIDER_INVALID_PARAMS_ERROR_CLASS,
            code: JSON_RPC_ERROR_CODE.InvalidParams,
            cause,
        });

        expect(errorClassName(error)).toBe(
            RPC_OBSERVABILITY_ERROR_CLASS.ProviderHeadLag,
        );
        expect(errorLogFields(error)).toMatchObject({
            errorClass: RPC_OBSERVABILITY_ERROR_CLASS.ProviderHeadLag,
            errorCode: JSON_RPC_ERROR_CODE.InvalidParams,
        });
    });
});
