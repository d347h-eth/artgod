import { RPC_RATE_LIMIT_MODE } from "@artgod/shared/evm/rpc-resilience";
import type { RpcEndpointResilienceConfig } from "@artgod/shared/evm/rpc-resilience";
import { getDefaultRpcEndpointResilienceConfig } from "@artgod/shared/config/rpc-resilience";
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
const TEST_EXACT_BLOCK = {
    chainId: 1,
    blockNumber: TEST_BLOCK_NUMBER,
    blockHash: `0x${"ab".repeat(32)}`,
};
const TEST_HTTP_FAILURE_RESPONSE_BODY = "upstream failed";
const TEST_HTTP_FAILURE_STATUS = 500;
const TEST_LOG_CHUNK_SIZE = 100;

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

describe("ViemRpcProvider RPC resilience", () => {
    it("reads code at an explicit historical block and preserves archive failures", async () => {
        const getBytecode = vi
            .fn()
            .mockResolvedValueOnce("0x1234")
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error("archive unavailable"));
        const provider = new ViemRpcProvider({
            endpoints: [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
            logChunkSize: TEST_LOG_CHUNK_SIZE,
            retryPolicy: TEST_SINGLE_ATTEMPT_RETRY_POLICY,
            resilience: DISABLED_RATE_LIMIT_RESILIENCE,
            createClient: () =>
                ({
                    getBytecode,
                }) as unknown as ReturnType<ViemRpcClientFactory>,
        });
        const address = "0x1111111111111111111111111111111111111111";
        await expect(
            provider.getBytecode(address, TEST_BLOCK_NUMBER),
        ).resolves.toBe("0x1234");
        await expect(
            provider.getBytecode(address, TEST_BLOCK_NUMBER),
        ).resolves.toBeNull();
        await expect(
            provider.getBytecode(address, TEST_BLOCK_NUMBER),
        ).rejects.toThrow("archive unavailable");
        expect(getBytecode).toHaveBeenCalledWith({
            address,
            blockNumber: BigInt(TEST_BLOCK_NUMBER),
        });
    });
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
                block: TEST_EXACT_BLOCK,
            }),
        ).resolves.toEqual([{ value: [false, false, 0n, 1n] }, { error }]);
        for (const contracts of [
            [],
            Array(RPC_CONTRACT_BATCH_MAX_CALLS + 1).fill(statusContract),
        ]) {
            await expect(
                provider.readContracts({
                    contracts,
                    block: TEST_EXACT_BLOCK,
                }),
            ).rejects.toThrow("Invalid bounded contract batch");
        }
        expect(multicall).toHaveBeenCalledTimes(1);
        expect(multicall).toHaveBeenCalledWith(
            expect.objectContaining({
                blockHash: TEST_EXACT_BLOCK.blockHash,
                requireCanonical: true,
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
            block: TEST_EXACT_BLOCK,
        });
        expect(results[0]).toEqual({ value: [false, false, 0n, 1n] });
        expect(results[1]).toHaveProperty("error");
        expect(calls.map((call) => new URL(call.url).origin)).toEqual([
            TEST_RPC_ENDPOINT_A_URL,
            TEST_RPC_ENDPOINT_B_URL,
        ]);
        for (const { body } of calls) {
            expect(body.method).toBe("eth_call");
            expect(body.params[1]).toEqual({
                blockHash: TEST_EXACT_BLOCK.blockHash,
                requireCanonical: true,
            });
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
        await provider.getBalance(address, { block: TEST_EXACT_BLOCK });
        expect(getBalance.mock.calls).toEqual([
            [{ address, blockNumber: BigInt(TEST_BLOCK_NUMBER) }],
            [{ address, blockNumber: undefined }],
            [
                {
                    address,
                    blockHash: TEST_EXACT_BLOCK.blockHash,
                    requireCanonical: true,
                },
            ],
        ]);
    });

    it.each(["contract", "balance"] as const)(
        "retains the same exact hash across %s endpoint retries and never falls back to a height",
        async (kind) => {
            const calls: Array<{ url: string; body: any }> = [];
            const result =
                kind === "balance"
                    ? "0x7"
                    : encodeFunctionResult({
                          abi: SEAPORT_VALIDATION_ABI,
                          functionName: "getOrderStatus",
                          result: [false, false, 0n, 0n],
                      });
            let refuseAll = false;
            vi.stubGlobal(
                "fetch",
                vi.fn(async (url, init) => {
                    const body = JSON.parse(init.body);
                    calls.push({ url: String(url), body });
                    return new Response(
                        JSON.stringify({
                            jsonrpc: "2.0",
                            id: body.id,
                            ...(refuseAll || calls.length === 1
                                ? {
                                      error: {
                                          code: -32001,
                                          message:
                                              "Requested block hash is not canonical at provider",
                                      },
                                  }
                                : { result }),
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
            const read = () =>
                kind === "balance"
                    ? provider.getBalance(statusContract.address, {
                          block: TEST_EXACT_BLOCK,
                      })
                    : provider.readContractAtBlock({
                          ...statusContract,
                          block: TEST_EXACT_BLOCK,
                      });
            await expect(read()).resolves.toEqual(
                kind === "balance" ? 7n : [false, false, 0n, 0n],
            );
            expect(calls.map((c) => new URL(c.url).origin)).toEqual([
                TEST_RPC_ENDPOINT_A_URL,
                TEST_RPC_ENDPOINT_B_URL,
            ]);
            refuseAll = true;
            await expect(read()).rejects.toThrow();
            for (const { body } of calls) {
                expect(body.method).toBe(
                    kind === "balance" ? "eth_getBalance" : "eth_call",
                );
                expect(body.params[1]).toEqual({
                    blockHash: TEST_EXACT_BLOCK.blockHash,
                    requireCanonical: true,
                });
            }
            expect(calls).toHaveLength(4);
        },
    );

    it("rejects invalid exact block identity and aggregate bounds before allocating RPC", async () => {
        const request = vi.fn();
        const multicall = vi.fn();
        const getBalance = vi.fn();
        const provider = new ViemRpcProvider({
            endpoints: [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
            logChunkSize: TEST_LOG_CHUNK_SIZE,
            retryPolicy: TEST_SINGLE_ATTEMPT_RETRY_POLICY,
            resilience: DISABLED_RATE_LIMIT_RESILIENCE,
            createClient: () =>
                ({
                    request,
                    multicall,
                    getBalance,
                }) as unknown as ReturnType<ViemRpcClientFactory>,
        });
        for (const block of [
            { ...TEST_EXACT_BLOCK, blockHash: "0x" },
            { ...TEST_EXACT_BLOCK, blockNumber: -1 },
            { ...TEST_EXACT_BLOCK, chainId: 0 },
        ]) {
            await expect(
                provider.readContractAtBlock({ ...statusContract, block }),
            ).rejects.toThrow("Invalid exact-block");
            await expect(
                provider.getBalance(statusContract.address, { block }),
            ).rejects.toThrow("Invalid exact-block");
            await expect(
                provider.readContracts({ contracts: [statusContract], block }),
            ).rejects.toThrow("Invalid exact-block");
        }
        expect(request).not.toHaveBeenCalled();
        expect(multicall).not.toHaveBeenCalled();
        expect(getBalance).not.toHaveBeenCalled();
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

    it("bypasses cached orphaned receipts when sync requests a fresh read", async () => {
        const txHash = `0x${"ab".repeat(32)}`;
        let blockHash = `0x${"cd".repeat(32)}`;
        const getTransactionReceipt = vi.fn(async () => ({
            transactionHash: txHash,
            logs: [
                {
                    address: "0x1111111111111111111111111111111111111111",
                    data: "0x",
                    topics: [],
                    blockNumber: BigInt(TEST_BLOCK_NUMBER),
                    blockHash,
                    transactionHash: txHash,
                    logIndex: 0,
                },
            ],
        }));
        const provider = new ViemRpcProvider({
            endpoints: [{ url: TEST_RPC_ENDPOINT_A_URL, weight: 1 }],
            logChunkSize: TEST_LOG_CHUNK_SIZE,
            retryPolicy: TEST_SINGLE_ATTEMPT_RETRY_POLICY,
            resilience: DISABLED_RATE_LIMIT_RESILIENCE,
            cache: new InMemoryCache({ maxEntries: 2, ttlMs: 60_000 }),
            createClient: () =>
                ({
                    getTransactionReceipt,
                }) as unknown as ReturnType<ViemRpcClientFactory>,
        });
        const original = await provider.getTransactionReceipt(txHash);
        blockHash = `0x${"ef".repeat(32)}`;
        expect(await provider.getTransactionReceipt(txHash)).toEqual(original);
        const fresh = await provider.getTransactionReceipt(txHash, {
            fresh: true,
        });
        expect(fresh.logs[0].blockHash).toBe(blockHash);
        expect(await provider.getTransactionReceipt(txHash)).toEqual(fresh);
        expect(getTransactionReceipt).toHaveBeenCalledTimes(2);
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
