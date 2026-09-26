import type { RpcEndpointResilienceConfig } from "@artgod/shared/evm/rpc-resilience";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    type ViemRpcClientFactory,
    ViemRpcProvider,
} from "../src/infra/rpc/viem.js";
import { InMemoryCache } from "../src/infra/cache/memory.js";
import { encodeFunctionResult, multicall3Abi } from "viem";
import { RPC_CONTRACT_BATCH_MAX_CALLS } from "../src/ports/rpc.js";
import { SEAPORT_VALIDATION_ABI } from "../src/abi/seaport-validation.js";

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
const TEST_LOG_CHUNK_SIZE = 100;

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

describe("ViemRpcProvider RPC resilience", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const statusContract = {
        address: "0x1111111111111111111111111111111111111111" as const,
        abi: SEAPORT_VALIDATION_ABI,
        functionName: "getOrderStatus",
        args: [`0x${"ab".repeat(32)}`],
    };

    it("preserves per-item aggregate failures and rejects oversized requests before RPC", async () => {
        const error = new Error("item response could not decode");
        const multicall = vi.fn(async () => [
            { status: "success", result: [false, false, 0n, 1n] },
            { status: "failure", error },
        ]);
        const provider = new ViemRpcProvider({
            endpoints: [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
            logChunkSize: TEST_LOG_CHUNK_SIZE,
            retryPolicy: TEST_SINGLE_ATTEMPT_RETRY_POLICY,
            resilience: DISABLED_RATE_LIMIT_RESILIENCE,
            createClient: () =>
                ({ multicall }) as unknown as ReturnType<ViemRpcClientFactory>,
        });
        await expect(
            provider.readContracts({
                contracts: [statusContract, statusContract],
                blockNumber: TEST_BLOCK_NUMBER,
            }),
        ).resolves.toEqual([{ value: [false, false, 0n, 1n] }, { error }]);
        for (const contracts of [
            [],
            Array(RPC_CONTRACT_BATCH_MAX_CALLS + 1).fill(statusContract),
        ]) {
            await expect(
                provider.readContracts({
                    contracts,
                    blockNumber: TEST_BLOCK_NUMBER,
                }),
            ).rejects.toThrow("Invalid bounded contract batch");
        }
        expect(multicall).toHaveBeenCalledTimes(1);
        expect(multicall).toHaveBeenCalledWith(
            expect.objectContaining({
                blockNumber: BigInt(TEST_BLOCK_NUMBER),
                deployless: true,
                allowFailure: true,
                batchSize: 0,
            }),
        );
    });

    it("encodes one pinned deployless call and retries outer HTTP failure through endpoint policy", async () => {
        const status = encodeFunctionResult({
            abi: SEAPORT_VALIDATION_ABI,
            functionName: "getOrderStatus",
            result: [false, false, 0n, 1n],
        });
        const encoded = encodeFunctionResult({
            abi: multicall3Abi,
            functionName: "aggregate3",
            result: [
                { success: true, returnData: status },
                { success: false, returnData: "0x" },
            ],
        });
        const calls: Array<{ url: string; body: any }> = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url, init) => {
                const body = JSON.parse(init.body);
                calls.push({ url: String(url), body });
                if (calls.length === 1)
                    return new Response(TEST_HTTP_FAILURE_RESPONSE_BODY, {
                        status: TEST_HTTP_FAILURE_STATUS,
                    });
                return new Response(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: body.id,
                        result: encoded,
                    }),
                    { headers: { "Content-Type": "application/json" } },
                );
            }),
        );
        const provider = new ViemRpcProvider({
            endpoints: [
                { url: TEST_RPC_ENDPOINT_A_URL, weight: 1 },
                { url: TEST_RPC_ENDPOINT_B_URL, weight: 1 },
            ],
            logChunkSize: TEST_LOG_CHUNK_SIZE,
            retryPolicy: TEST_RETRY_POLICY,
            resilience: DISABLED_RATE_LIMIT_RESILIENCE,
        });
        const results = await provider.readContracts({
            contracts: [statusContract, statusContract],
            blockNumber: TEST_BLOCK_NUMBER,
        });
        expect(results[0]).toEqual({ value: [false, false, 0n, 1n] });
        expect(results[1]).toHaveProperty("error");
        expect(calls.map((call) => new URL(call.url).origin)).toEqual([
            TEST_RPC_ENDPOINT_A_URL,
            TEST_RPC_ENDPOINT_B_URL,
        ]);
        for (const { body } of calls) {
            expect(body.method).toBe("eth_call");
            expect(body.params[1]).toBe(`0x${TEST_BLOCK_NUMBER.toString(16)}`);
            expect(body.params[0].to).toBeUndefined();
        }
    });

    it("forwards a native balance snapshot block without changing unpinned callers", async () => {
        const getBalance = vi.fn(async () => 1n);
        const provider = new ViemRpcProvider({
            endpoints: [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
            logChunkSize: TEST_LOG_CHUNK_SIZE,
            retryPolicy: TEST_SINGLE_ATTEMPT_RETRY_POLICY,
            resilience: DISABLED_RATE_LIMIT_RESILIENCE,
            createClient: () =>
                ({ getBalance }) as unknown as ReturnType<ViemRpcClientFactory>,
        });
        const address = "0x1111111111111111111111111111111111111111";
        await provider.getBalance(address, { blockNumber: TEST_BLOCK_NUMBER });
        await provider.getBalance(address);
        expect(getBalance.mock.calls).toEqual([
            [{ address, blockNumber: BigInt(TEST_BLOCK_NUMBER) }],
            [{ address, blockNumber: undefined }],
        ]);
    });

    it("bypasses the block cache for validation canonicality checks", async () => {
        let hash = `0x${"ab".repeat(32)}`;
        const getBlock = vi.fn(async () => ({
            number: BigInt(TEST_BLOCK_NUMBER),
            hash,
            parentHash: hash,
            timestamp: 1_790_208_000n,
            transactions: [],
        }));
        const provider = new ViemRpcProvider({
            endpoints: [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
            logChunkSize: TEST_LOG_CHUNK_SIZE,
            retryPolicy: TEST_SINGLE_ATTEMPT_RETRY_POLICY,
            resilience: DISABLED_RATE_LIMIT_RESILIENCE,
            cache: new InMemoryCache({ maxEntries: 2, ttlMs: 60_000 }),
            createClient: () =>
                ({ getBlock }) as unknown as ReturnType<ViemRpcClientFactory>,
        });
        const original = await provider.getBlock(TEST_BLOCK_NUMBER);
        hash = `0x${"cd".repeat(32)}`;
        expect(await provider.getBlock(TEST_BLOCK_NUMBER)).toEqual(original);
        expect(
            (await provider.getBlock(TEST_BLOCK_NUMBER, { fresh: true })).hash,
        ).toBe(hash);
        expect(getBlock).toHaveBeenCalledTimes(2);
    });

    it("retries failed reads through the next weighted endpoint", async () => {
        const attemptedUrls: string[] = [];
        const createClient: ViemRpcClientFactory = (url) =>
            ({
                getBlockNumber: async () => {
                    attemptedUrls.push(url);
                    if (url === TEST_RPC_ENDPOINT_A_URL) {
                        throw new Error(TEST_RPC_ENDPOINT_FAILURE_MESSAGE);
                    }
                    return BigInt(TEST_BLOCK_NUMBER);
                },
            }) as ReturnType<ViemRpcClientFactory>;
        const provider = new ViemRpcProvider({
            endpoints: [
                { url: TEST_RPC_ENDPOINT_A_URL, weight: 1 },
                { url: TEST_RPC_ENDPOINT_B_URL, weight: 1 },
            ],
            logChunkSize: TEST_LOG_CHUNK_SIZE,
            retryPolicy: TEST_RETRY_POLICY,
            resilience: DISABLED_RATE_LIMIT_RESILIENCE,
            createClient,
        });

        await expect(provider.getBlockNumber()).resolves.toBe(
            TEST_BLOCK_NUMBER,
        );
        expect(attemptedUrls).toEqual([
            TEST_RPC_ENDPOINT_A_URL,
            TEST_RPC_ENDPOINT_B_URL,
        ]);
    });

    it("disables viem internal retries under the indexer RPC retry policy", async () => {
        const fetchMock = vi.fn(
            async () =>
                new Response(TEST_HTTP_FAILURE_RESPONSE_BODY, {
                    status: TEST_HTTP_FAILURE_STATUS,
                }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const provider = new ViemRpcProvider({
            endpoints: [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
            logChunkSize: TEST_LOG_CHUNK_SIZE,
            retryPolicy: TEST_SINGLE_ATTEMPT_RETRY_POLICY,
            resilience: DISABLED_RATE_LIMIT_RESILIENCE,
        });

        await expect(provider.getBlockNumber()).rejects.toThrow();

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
