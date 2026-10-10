import { RPC_RATE_LIMIT_MODE } from "@artgod/shared/evm/rpc-resilience";
import type { RpcEndpointResilienceConfig } from "@artgod/shared/evm/rpc-resilience";
import { getDefaultRpcEndpointResilienceConfig } from "@artgod/shared/config/rpc-resilience";
import { NOOP_APM } from "@artgod/shared/observability/apm";
import { RPC_OBSERVABILITY_LOG_MESSAGE } from "@artgod/shared/observability/rpc";
import { BOOTSTRAP_TEST_OBSERVATION } from "@artgod/shared/testing/bootstrap-probe";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import {
    getRpcResponseBodySizeLimit,
    JSON_RPC_ERROR_CODE,
} from "@artgod/shared/evm/rpc-errors";
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
const TEST_CONTRACT_ABI = [
    {
        type: "function",
        name: TEST_CONTRACT_FUNCTION_NAME,
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
    },
] as const;
const TEST_CONTRACT_READ = {
    address: TEST_CONTRACT_ADDRESS,
    functionName: TEST_CONTRACT_FUNCTION_NAME,
    abi: TEST_CONTRACT_ABI,
} as const;
const TEST_ENCODED_CONTRACT_RESULT = encodeAbiParameters(
    parseAbiParameters("string"),
    [TEST_CONTRACT_RESULT],
);
function rpcResponse(payload: {
    result?: string;
    error?: { code: number; message: string; data?: string };
}): Response {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...payload }), {
        headers: { "content-type": "application/json" },
    });
}

const DISABLED_RATE_LIMIT_RESILIENCE: RpcEndpointResilienceConfig = {
    ...getDefaultRpcEndpointResilienceConfig(),
    requestTimeoutMs: TEST_REQUEST_TIMEOUT_MS,
    rateLimiter: { mode: RPC_RATE_LIMIT_MODE.Unlimited },
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

    it.each([
        { name: "lower", largerLimit: false },
        { name: "higher", largerLimit: true },
    ])("honors a $name HTTP RPC response limit", async ({ largerLimit }) => {
        const defaultLimit =
            getDefaultRpcEndpointResilienceConfig().maxResponseBodySizeBytes;
        const maxResponseBodySizeBytes = largerLimit
            ? defaultLimit * 2
            : 524_288;
        const responseSize =
            (largerLimit ? defaultLimit : maxResponseBodySizeBytes) + 1;
        const fetchMock = vi.fn(
            // A declared size exercises viem's guard without allocating a large body.
            async () =>
                new Response(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        result: "0x7b",
                    }),
                    {
                        headers: {
                            "content-type": "application/json",
                            "content-length": String(responseSize),
                        },
                    },
                ),
        );
        vi.stubGlobal("fetch", fetchMock);
        const client = new ViemBackendRpcClient(
            [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
            NOOP_APM,
            undefined,
            {
                retryPolicy: TEST_RETRY_POLICY,
                resilience: {
                    ...DISABLED_RATE_LIMIT_RESILIENCE,
                    maxResponseBodySizeBytes,
                },
            },
        );

        if (largerLimit) {
            await expect(client.getCurrentBlockNumber()).resolves.toBe(
                TEST_BLOCK_NUMBER,
            );
        } else {
            const error = await client
                .getCurrentBlockNumber()
                .catch((error: unknown) => error);
            expect(getRpcResponseBodySizeLimit(error)).toEqual({
                maxSize: maxResponseBodySizeBytes,
                size: responseSize,
            });
        }
        expect(fetchMock).toHaveBeenCalledTimes(1);
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

    it.each([
        { name: "empty successful response", payload: { result: "0x" } },
        {
            name: "empty revert",
            payload: {
                error: { code: 3, message: "execution reverted", data: "0x" },
            },
        },
        {
            name: "unknown custom revert",
            payload: {
                error: {
                    code: 3,
                    message: "execution reverted",
                    data: "0xdeadbeef",
                },
            },
        },
        {
            name: "missing selector",
            payload: {
                error: {
                    code: -32000,
                    message: "function selector was not recognized",
                    data: "0x",
                },
            },
        },
    ])(
        "does not retry or open the circuit for an optional $name through real viem decoding",
        async ({ payload }) => {
            const fetchMock = vi.fn(async () => rpcResponse(payload));
            vi.stubGlobal("fetch", fetchMock);
            const sleep = vi.fn(async () => {});
            const client = new ViemBackendRpcClient(
                [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
                NOOP_APM,
                undefined,
                {
                    retryPolicy: { ...TEST_RETRY_POLICY, maxAttempts: 10 },
                    sleep,
                    resilience: {
                        ...DISABLED_RATE_LIMIT_RESILIENCE,
                        circuitBreaker: {
                            ...DISABLED_RATE_LIMIT_RESILIENCE.circuitBreaker,
                            failureThreshold: 1,
                        },
                    },
                },
            );
            for (let call = 0; call < 2; call += 1) {
                await expect(
                    client.readContract({
                        ...TEST_CONTRACT_READ,
                        retryZeroData: false,
                    }),
                ).rejects.toThrow();
                expect(fetchMock).toHaveBeenCalledTimes(call + 1);
                expect(sleep).not.toHaveBeenCalled();
            }
        },
    );

    it.each([
        {
            name: "HTTP 503",
            response: () => new Response(null, { status: 503 }),
        },
        {
            name: "unavailable historical state",
            response: () =>
                rpcResponse({
                    error: {
                        code: JSON_RPC_ERROR_CODE.InvalidParams,
                        message: "historical state is not available",
                    },
                }),
        },
        {
            name: "historical state reported as an internal JSON-RPC error",
            response: () =>
                rpcResponse({
                    error: {
                        code: -32603,
                        message: "historical state is not available",
                    },
                }),
        },
        {
            name: "transport failure",
            response: () => {
                throw new Error("fetch failed");
            },
        },
    ])(
        "retains the standard retry policy for optional reads after $name",
        async ({ response }) => {
            const fetchMock = vi
                .fn()
                .mockImplementationOnce(async () => response())
                .mockImplementation(async () =>
                    rpcResponse({ result: TEST_ENCODED_CONTRACT_RESULT }),
                );
            vi.stubGlobal("fetch", fetchMock);
            const sleep = vi.fn(async () => {});
            const client = new ViemBackendRpcClient(
                [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
                NOOP_APM,
                undefined,
                {
                    retryPolicy: TEST_RETRY_POLICY,
                    resilience: DISABLED_RATE_LIMIT_RESILIENCE,
                    sleep,
                },
            );
            await expect(
                client.readContract({
                    ...TEST_CONTRACT_READ,
                    retryZeroData: false,
                }),
            ).resolves.toBe(TEST_CONTRACT_RESULT);
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(sleep).toHaveBeenCalledTimes(1);
        },
    );

    it("retains zero-data endpoint failover for required reads through real viem decoding", async () => {
        const fetchMock = vi
            .fn()
            .mockImplementationOnce(async () => rpcResponse({ result: "0x" }))
            .mockImplementation(async () =>
                rpcResponse({ result: TEST_ENCODED_CONTRACT_RESULT }),
            );
        vi.stubGlobal("fetch", fetchMock);
        const sleep = vi.fn(async () => {});
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
                sleep,
            },
        );
        await expect(client.readContract(TEST_CONTRACT_READ)).resolves.toBe(
            TEST_CONTRACT_RESULT,
        );
        expect(
            fetchMock.mock.calls.map((call) => new URL(String(call[0])).origin),
        ).toEqual([TEST_RPC_ENDPOINT_A_URL, TEST_RPC_ENDPOINT_B_URL]);
        expect(sleep).toHaveBeenCalledTimes(1);
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

    it("pins probe observations to finalized blocks and forwards the same block to code reads", async () => {
        const getBlock = vi.fn(async () => ({
            number: BigInt(BOOTSTRAP_TEST_OBSERVATION.blockNumber),
            hash: BOOTSTRAP_TEST_OBSERVATION.blockHash,
        }));
        const getBytecode = vi.fn(async () => "0x6000");
        const client = new ViemBackendRpcClient(
            [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
            NOOP_APM,
            undefined,
            {
                retryPolicy: TEST_SINGLE_ATTEMPT_RETRY_POLICY,
                resilience: DISABLED_RATE_LIMIT_RESILIENCE,
                createClient: () =>
                    ({
                        getBlock,
                        getBytecode,
                    }) as unknown as ReturnType<BackendRpcClientFactory>,
            },
        );
        expect(await client.getProbeBlock()).toEqual(
            BOOTSTRAP_TEST_OBSERVATION,
        );
        expect(getBlock).toHaveBeenLastCalledWith({ blockTag: "finalized" });
        expect(
            await client.getProbeBlock(BOOTSTRAP_TEST_OBSERVATION.blockNumber),
        ).toEqual(BOOTSTRAP_TEST_OBSERVATION);
        expect(getBlock).toHaveBeenLastCalledWith({
            blockNumber: BigInt(BOOTSTRAP_TEST_OBSERVATION.blockNumber),
        });
        await client.getBytecode(
            TEST_CONTRACT_ADDRESS,
            BOOTSTRAP_TEST_OBSERVATION.blockNumber,
        );
        expect(getBytecode).toHaveBeenCalledWith({
            address: TEST_CONTRACT_ADDRESS,
            blockNumber: BigInt(BOOTSTRAP_TEST_OBSERVATION.blockNumber),
        });
    });

    it.each([
        { number: null, hash: null },
        {
            number: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
            hash: BOOTSTRAP_TEST_OBSERVATION.blockHash,
        },
    ])(
        "rejects unavailable or unsupported observation blocks",
        async (block) => {
            const client = new ViemBackendRpcClient(
                [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
                NOOP_APM,
                undefined,
                {
                    retryPolicy: TEST_SINGLE_ATTEMPT_RETRY_POLICY,
                    resilience: DISABLED_RATE_LIMIT_RESILIENCE,
                    createClient: () =>
                        ({
                            getBlock: async () => block,
                        }) as unknown as ReturnType<BackendRpcClientFactory>,
                },
            );
            await expect(client.getProbeBlock()).rejects.toThrow(/Probe block/);
        },
    );
});
