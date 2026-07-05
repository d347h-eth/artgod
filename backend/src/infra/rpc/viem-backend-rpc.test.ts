import type { RpcEndpointResilienceConfig } from "@artgod/shared/evm/rpc-resilience";
import { NOOP_APM } from "@artgod/shared/observability/apm";
import { RPC_OBSERVABILITY_LOG_MESSAGE } from "@artgod/shared/observability/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    BACKEND_RPC_LOG_FIELD,
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
const TEST_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000001234";
const TEST_CONTRACT_FUNCTION_NAME = "tokenHTML";
const TEST_CONTRACT_ARG = 7710n;
const TEST_CONTRACT_ARG_TEXT = "renderer";
const TEST_CONTRACT_RESULT = "<html>live</html>";
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
        vi.restoreAllMocks();
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

    it("logs read contract function metadata and compact args", async () => {
        const logLines: string[] = [];
        vi.spyOn(console, "log").mockImplementation((line?: unknown) => {
            logLines.push(String(line));
        });
        const readContract = vi.fn(async () => TEST_CONTRACT_RESULT);
        const createClient: BackendRpcClientFactory = () =>
            ({
                readContract,
            }) as unknown as ReturnType<BackendRpcClientFactory>;
        const client = new ViemBackendRpcClient(
            [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
            NOOP_APM,
            undefined,
            {
                retryPolicy: TEST_SINGLE_ATTEMPT_RETRY_POLICY,
                resilience: DISABLED_RATE_LIMIT_RESILIENCE,
                createClient,
            },
        );
        logLines.length = 0;

        await expect(
            client.readContract({
                address: TEST_CONTRACT_ADDRESS,
                abi: [],
                functionName: TEST_CONTRACT_FUNCTION_NAME,
                args: [TEST_CONTRACT_ARG, TEST_CONTRACT_ARG_TEXT],
                blockNumber: TEST_BLOCK_NUMBER,
            }),
        ).resolves.toBe(TEST_CONTRACT_RESULT);

        expect(readContract).toHaveBeenCalledWith(
            expect.objectContaining({
                address: TEST_CONTRACT_ADDRESS,
                functionName: TEST_CONTRACT_FUNCTION_NAME,
                args: [TEST_CONTRACT_ARG, TEST_CONTRACT_ARG_TEXT],
                blockNumber: BigInt(TEST_BLOCK_NUMBER),
            }),
        );
        const logs = logLines.map(
            (line) => JSON.parse(line) as Record<string, unknown>,
        );
        const attemptStarted = logs.find(
            (log) =>
                log.msg ===
                RPC_OBSERVABILITY_LOG_MESSAGE.EndpointAttemptStarted,
        );
        const callSucceeded = logs.find(
            (log) => log.msg === RPC_OBSERVABILITY_LOG_MESSAGE.CallSucceeded,
        );
        const expectedMetadata = {
            [BACKEND_RPC_LOG_FIELD.ContractAddress]: TEST_CONTRACT_ADDRESS,
            [BACKEND_RPC_LOG_FIELD.FunctionName]: TEST_CONTRACT_FUNCTION_NAME,
            [BACKEND_RPC_LOG_FIELD.Args]: [
                TEST_CONTRACT_ARG.toString(),
                TEST_CONTRACT_ARG_TEXT,
            ],
            [BACKEND_RPC_LOG_FIELD.ArgsCount]: 2,
            [BACKEND_RPC_LOG_FIELD.BlockNumber]: TEST_BLOCK_NUMBER,
        };
        expect(attemptStarted).toMatchObject(expectedMetadata);
        expect(callSucceeded).toMatchObject(expectedMetadata);
    });
});
