import type { RpcEndpointResilienceConfig } from "@artgod/shared/evm/rpc-resilience";
import { NOOP_APM } from "@artgod/shared/observability/apm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    type BackendRpcClientFactory,
    ViemBackendRpcClient,
} from "./viem-backend-rpc.js";

const TEST_RETRY_POLICY = {
    maxAttempts: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
};
const TEST_SINGLE_ATTEMPT_RETRY_POLICY = {
    maxAttempts: 1,
    baseDelayMs: 0,
    maxDelayMs: 0,
};
const TEST_REQUEST_TIMEOUT_MS = 5_000;
const TEST_RPC_ENDPOINT_A_URL = "https://rpc-a.example";
const TEST_RPC_ENDPOINT_B_URL = "https://rpc-b.example";
const TEST_RPC_ENDPOINT_FAILURE_MESSAGE = "rpc-a unavailable";
const TEST_BLOCK_NUMBER = 123;
const TEST_HTTP_FAILURE_RESPONSE_BODY = "upstream failed";
const TEST_HTTP_FAILURE_STATUS = 500;

const DISABLED_RATE_LIMIT_RESILIENCE: RpcEndpointResilienceConfig = {
    requestTimeoutMs: TEST_REQUEST_TIMEOUT_MS,
    rateLimiter: {
        requestsPerSecond: 0,
        burst: 1,
    },
    circuitBreaker: {
        failureThreshold: 10,
        openMs: 1000,
        halfOpenMaxRequests: 1,
    },
};

describe("ViemBackendRpcClient", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("retries failed reads through the next weighted endpoint", async () => {
        const attemptedUrls: string[] = [];
        const createClient: BackendRpcClientFactory = (url) =>
            ({
                getBlockNumber: async () => {
                    attemptedUrls.push(url);
                    if (url === TEST_RPC_ENDPOINT_A_URL) {
                        throw new Error(TEST_RPC_ENDPOINT_FAILURE_MESSAGE);
                    }
                    return BigInt(TEST_BLOCK_NUMBER);
                },
            }) as ReturnType<BackendRpcClientFactory>;
        const client = new ViemBackendRpcClient(
            [
                { url: TEST_RPC_ENDPOINT_A_URL, weight: 1 },
                { url: TEST_RPC_ENDPOINT_B_URL, weight: 1 },
            ],
            NOOP_APM,
            undefined,
            {
                retryPolicy: TEST_RETRY_POLICY,
                resilience: DISABLED_RATE_LIMIT_RESILIENCE,
                sleep: async () => {},
                createClient,
            },
        );

        await expect(client.getCurrentBlockNumber()).resolves.toBe(
            TEST_BLOCK_NUMBER,
        );
        expect(attemptedUrls).toEqual([
            TEST_RPC_ENDPOINT_A_URL,
            TEST_RPC_ENDPOINT_B_URL,
        ]);
    });

    it("disables viem internal retries under the backend RPC retry policy", async () => {
        const fetchMock = vi.fn(
            async () =>
                new Response(TEST_HTTP_FAILURE_RESPONSE_BODY, {
                    status: TEST_HTTP_FAILURE_STATUS,
                }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const client = new ViemBackendRpcClient(
            [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
            NOOP_APM,
            undefined,
            {
                retryPolicy: TEST_SINGLE_ATTEMPT_RETRY_POLICY,
                resilience: DISABLED_RATE_LIMIT_RESILIENCE,
            },
        );

        await expect(client.getCurrentBlockNumber()).rejects.toThrow();

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
