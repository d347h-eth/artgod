import { afterEach, describe, expect, it, vi } from "vitest";
import {
    errorClassName,
    errorLogFields,
    RPC_OBSERVABILITY_ERROR_CLASS,
    RPC_OBSERVABILITY_EVENT,
    RPC_OBSERVABILITY_LOG_ACTION,
    RPC_OBSERVABILITY_LOG_MESSAGE,
    RPC_OBSERVABILITY_METRIC,
    RPC_OBSERVABILITY_LABEL,
    RPC_OBSERVABILITY_RESULT,
    RPC_OBSERVABILITY_SENTINEL,
    RPC_OBSERVABILITY_WORKSPACE,
    RPC_PROTOCOL,
    RpcObservability,
    type RpcObservabilityConfig,
} from "./rpc.js";
import {
    flushPendingLogReports,
    LOG_REPORTING_POLICY,
} from "./log-reporting.js";
import type { MetricLabels, Metrics } from "./metrics/types.js";
import type { LogLevel } from "../utils/logger.js";
import { createPrometheusMetrics } from "./metrics/index.js";
import { SYNC_WORK_CLASS } from "../types/sync-work-class.js";
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

afterEach(() => {
    flushPendingLogReports();
    vi.useRealTimers();
});

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

describe("RpcObservability", () => {
    it("aggregates successful calls, attempts and waits once per minute while keeping every metric observation", () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const { observer, logs, metrics, endpoint } = captureRpc();
        for (let i = 0; i < 500; i++) {
            const call = observer.startCall(TEST_RPC_METHOD, {
                orderId: `order-${i}`,
            });
            const attempt = observer.startEndpointAttempt(call, endpoint, 1);
            observer.recordRateLimitWait({
                method: TEST_RPC_METHOD,
                endpoint,
                waitedMs: i % 10,
            });
            vi.advanceTimersByTime(3);
            observer.recordEndpointAttemptSuccess(attempt, endpoint);
            observer.recordCallSuccess(call, endpoint);
        }
        expect(logs).toEqual([]);
        expect(
            metrics.increments.filter(
                ({ name }) => name === RPC_OBSERVABILITY_METRIC.Call,
            ),
        ).toHaveLength(500);
        expect(
            metrics.increments.filter(
                ({ name }) => name === RPC_OBSERVABILITY_METRIC.EndpointAttempt,
            ),
        ).toHaveLength(500);
        expect(
            metrics.histograms.filter(
                ({ name }) =>
                    name === RPC_OBSERVABILITY_METRIC.RateLimiterWaitMs,
            ),
        ).toHaveLength(500);
        vi.advanceTimersByTime(LOG_REPORTING_POLICY.intervalMs - Date.now());
        expect(logs).toEqual([
            {
                level: "info",
                message: RPC_OBSERVABILITY_LOG_MESSAGE.Progress,
                meta: {
                    component: TEST_LOG_COMPONENT,
                    workspace: RPC_OBSERVABILITY_WORKSPACE.Indexer,
                    rpcComponent: TEST_RPC_COMPONENT,
                    protocol: RPC_PROTOCOL.Http,
                    action: RPC_OBSERVABILITY_LOG_ACTION.Progress,
                    startedAt: 0,
                    endedAt: Date.now(),
                    windowMs: LOG_REPORTING_POLICY.intervalMs,
                    callsStarted: 500,
                    callsSucceeded: 500,
                    callsFailed: 0,
                    attemptsStarted: 500,
                    attemptsSucceeded: 500,
                    attemptsFailed: 0,
                    retriesScheduled: 0,
                    circuitsOpened: 0,
                    headsReceived: 0,
                    rateLimitWaits: 500,
                    rateLimitWaitMs: 2250,
                    maximumRateLimitWaitMs: 9,
                    callDurationMs: 1500,
                    maximumCallDurationMs: 3,
                    attemptDurationMs: 1500,
                    maximumAttemptDurationMs: 3,
                },
            },
        ]);
        expect(JSON.stringify(logs)).not.toContain("order-");
        expect(JSON.stringify(logs)).not.toContain(TEST_RPC_ENDPOINT_URL);
        vi.advanceTimersByTime(2 * LOG_REPORTING_POLICY.intervalMs);
        expect(logs).toHaveLength(1);
    });

    it("keeps warnings and connection lifecycle events immediate while aggregating heads and failure totals", () => {
        vi.useFakeTimers();
        const { observer, logs, endpoint } = captureRpc({
            protocol: RPC_PROTOCOL.WebSocket,
        });
        const call = observer.startCall(TEST_RPC_METHOD);
        const attempt = observer.startEndpointAttempt(call, endpoint, 1);
        const error = new Error("provider failed");
        observer.recordEndpointAttemptFailure(attempt, endpoint, error);
        observer.recordCallFailure(call, endpoint, error);
        observer.recordRetryScheduled({
            method: TEST_RPC_METHOD,
            endpoint,
            attempt: 1,
            nextAttempt: 2,
            delayMs: 50,
        });
        observer.recordCircuitOpen(TEST_RPC_METHOD, endpoint, error);
        observer.recordEndpointEvent({
            event: RPC_OBSERVABILITY_EVENT.Connected,
            method: TEST_RPC_METHOD,
            endpoint,
        });
        for (let i = 0; i < 3; i++)
            observer.recordEndpointEvent({
                event: RPC_OBSERVABILITY_EVENT.HeadReceived,
                method: TEST_RPC_METHOD,
                endpoint,
            });
        expect(logs.map(({ level }) => level)).toEqual([
            "warn",
            "warn",
            "warn",
            "warn",
            "debug",
        ]);
        flushPendingLogReports();
        expect(logs.at(-1)).toMatchObject({
            level: "info",
            message: RPC_OBSERVABILITY_LOG_MESSAGE.Progress,
            meta: {
                callsStarted: 1,
                callsFailed: 1,
                attemptsStarted: 1,
                attemptsFailed: 1,
                retriesScheduled: 1,
                circuitsOpened: 1,
                headsReceived: 3,
            },
        });
    });

    it("allows an explicit diagnostic caller to retain routine detail alongside the summary", () => {
        const { observer, logs, endpoint } = captureRpc({ detailedLogs: true });
        const call = observer.startCall(TEST_RPC_METHOD);
        const attempt = observer.startEndpointAttempt(call, endpoint, 1);
        observer.recordEndpointAttemptSuccess(attempt, endpoint);
        observer.recordCallSuccess(call, endpoint);
        observer.recordRateLimitWait({
            method: TEST_RPC_METHOD,
            endpoint,
            waitedMs: 10,
        });
        expect(logs.map(({ message }) => message)).toEqual([
            RPC_OBSERVABILITY_LOG_MESSAGE.EndpointAttemptStarted,
            RPC_OBSERVABILITY_LOG_MESSAGE.EndpointAttemptSucceeded,
            RPC_OBSERVABILITY_LOG_MESSAGE.CallSucceeded,
            RPC_OBSERVABILITY_LOG_MESSAGE.RateLimiterWaited,
        ]);
        flushPendingLogReports();
        expect(logs.at(-1)?.message).toBe(
            RPC_OBSERVABILITY_LOG_MESSAGE.Progress,
        );
    });

    it("exports both work classes after an unclassified call registers the shared metric", async () => {
        const metrics = await createPrometheusMetrics({
            collectProcessMetrics: false,
        });
        expect(metrics).toBeDefined();
        const observer = new RpcObservability({
            workspace: RPC_OBSERVABILITY_WORKSPACE.Indexer,
            component: TEST_RPC_COMPONENT,
            protocol: RPC_PROTOCOL.Http,
            metrics: metrics!,
            logger: {
                debug: () => {},
                info: () => {},
                warn: () => {},
                error: () => {},
            },
        });
        const endpoint = {
            id: TEST_RPC_ENDPOINT_ID,
            url: TEST_RPC_ENDPOINT_URL,
            configuredWeight: 1,
            effectiveWeight: 1,
        };
        for (const workClass of [
            undefined,
            ...Object.values(SYNC_WORK_CLASS),
        ]) {
            const call = observer.startCall(
                TEST_RPC_METHOD,
                undefined,
                workClass,
            );
            const attempt = observer.startEndpointAttempt(call, endpoint, 1);
            observer.recordEndpointAttemptSuccess(attempt, endpoint);
            observer.recordCallSuccess(call, endpoint);
        }
        const scrape = await metrics!.metricsText();
        for (const value of [
            RPC_OBSERVABILITY_SENTINEL.NoWorkClass,
            ...Object.values(SYNC_WORK_CLASS),
        ])
            expect(scrape).toContain(
                `${RPC_OBSERVABILITY_LABEL.WorkClass}="${value}"`,
            );
        expect(scrape).not.toContain("api-key");
    });

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
                [RPC_OBSERVABILITY_LABEL.WorkClass]:
                    RPC_OBSERVABILITY_SENTINEL.NoWorkClass,
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
                [RPC_OBSERVABILITY_LABEL.WorkClass]:
                    RPC_OBSERVABILITY_SENTINEL.NoWorkClass,
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
                [RPC_OBSERVABILITY_LABEL.WorkClass]:
                    RPC_OBSERVABILITY_SENTINEL.NoWorkClass,
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
            data: RPC_PROVIDER_HEAD_LAG_ERROR_DATA.FromBlockGreaterThanLatestBlock,
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

function captureRpc(
    config?: Partial<Pick<RpcObservabilityConfig, "detailedLogs" | "protocol">>,
) {
    const logs: Array<{
        level: LogLevel;
        message: string;
        meta?: Record<string, unknown>;
    }> = [];
    const capture =
        (level: LogLevel) =>
        (message: string, meta?: Record<string, unknown>) => {
            logs.push({ level, message, meta });
        };
    const metrics = new CapturingMetrics();
    const observer = new RpcObservability({
        workspace: RPC_OBSERVABILITY_WORKSPACE.Indexer,
        component: TEST_RPC_COMPONENT,
        protocol: RPC_PROTOCOL.Http,
        logComponent: TEST_LOG_COMPONENT,
        metrics,
        logger: {
            debug: capture("debug"),
            info: capture("info"),
            warn: capture("warn"),
            error: capture("error"),
        },
        ...config,
    });
    const endpoint = {
        id: TEST_RPC_ENDPOINT_ID,
        url: TEST_RPC_ENDPOINT_URL,
        configuredWeight: 1,
        effectiveWeight: 1,
    };
    return { observer, logs, metrics, endpoint };
}
