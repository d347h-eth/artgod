import { RPC_RATE_LIMIT_MODE } from "@artgod/shared/evm/rpc-resilience";
import { RpcRequestTimeoutError } from "@artgod/shared/evm/rpc-resilience";
import { RpcRequestCancelledError } from "@artgod/shared/evm/rpc-errors";
import { SYNC_WORK_CLASS } from "@artgod/shared/types/sync-work-class";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    BaseError,
    ResponseBodyTooLargeError,
    encodeEventTopics,
    zeroAddress,
} from "viem";
import { getDefaultRpcEndpointResilienceConfig } from "@artgod/shared/config/rpc-resilience";
import { logger } from "@artgod/shared/utils/logger";
import {
    INDEXER_RPC_LOG_ACTION,
    INDEXER_RPC_LOG_MESSAGE,
} from "../src/infra/rpc/observability.js";
import {
    type ViemRpcClientFactory,
    ViemRpcProvider,
} from "../src/infra/rpc/viem.js";
import { ERC721_ABI, ERC721_EVENT_NAME } from "../src/abi/index.js";

const MINT_FILTER = {
    address: "0x1111111111111111111111111111111111111111" as const,
    event: ERC721_ABI[0],
    args: { from: zeroAddress, tokenId: 52_000_000n },
    fromBlock: 0,
    toBlock: 100,
};

const TEST_RPC_URL = "https://rpc.example";
const TEST_BACKUP_RPC_URL = "https://rpc-backup.example";
const TEST_ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const TEST_HASH = `0x${"ab".repeat(32)}`;
const TEST_RESPONSE_LIMIT_BYTES =
    getDefaultRpcEndpointResilienceConfig().maxResponseBodySizeBytes;
const TEST_RETRY_POLICY = { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 };
const TEST_RESILIENCE = {
    ...getDefaultRpcEndpointResilienceConfig(),
    requestTimeoutMs: 5_000,
    rateLimiter: { mode: RPC_RATE_LIMIT_MODE.Unlimited },
    circuitBreaker: {
        failureThreshold: 1,
        openMs: 10_000,
        halfOpenMaxRequests: 1,
    },
};

type LogRequest = { fromBlock: bigint; toBlock: bigint };

function sizeError(): ResponseBodyTooLargeError {
    return new ResponseBodyTooLargeError({
        maxSize: TEST_RESPONSE_LIMIT_BYTES,
        size: TEST_RESPONSE_LIMIT_BYTES + 1,
    });
}

function rawLog(blockNumber: number) {
    return {
        address: TEST_ADDRESS,
        data: "0x",
        topics: [],
        blockNumber: `0x${blockNumber.toString(16)}`,
        blockHash: TEST_HASH,
        transactionHash: TEST_HASH,
        logIndex: "0x0",
        transactionIndex: "0x0",
        removed: false,
    };
}

function logsForRange({ fromBlock, toBlock }: LogRequest) {
    return Array.from(
        { length: Number(toBlock - fromBlock + 1n) },
        (_, index) => ({
            ...rawLog(Number(fromBlock) + index),
            blockNumber: fromBlock + BigInt(index),
            logIndex: 0n,
        }),
    );
}

function providerWith(getLogs: (params: LogRequest) => Promise<unknown[]>) {
    return new ViemRpcProvider({
        endpoints: [{ url: TEST_RPC_URL, weight: 1 }],
        logChunkSize: 8,
        retryPolicy: TEST_RETRY_POLICY,
        resilience: TEST_RESILIENCE,
        createClient: () =>
            ({ getLogs }) as unknown as ReturnType<ViemRpcClientFactory>,
    });
}

describe("RPC log response-size recovery", () => {
    beforeEach(() => {
        for (const level of ["debug", "info", "warn", "error"] as const) {
            vi.spyOn(logger, level).mockImplementation(() => {});
        }
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("filters the mint sender and exact token on the RPC wire and returns the earliest mint even after a remint", async () => {
        const topics = encodeEventTopics({
            abi: ERC721_ABI,
            eventName: ERC721_EVENT_NAME.Transfer,
            args: {
                from: zeroAddress,
                to: TEST_ADDRESS,
                tokenId: MINT_FILTER.args.tokenId,
            },
        });
        let request: any;
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url, init) => {
                request = JSON.parse(init.body);
                return new Response(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: request.id,
                        result: [rawLog(15), rawLog(12)].map((log) => ({
                            ...log,
                            topics,
                        })),
                    }),
                    { headers: { "Content-Type": "application/json" } },
                );
            }),
        );
        const provider = new ViemRpcProvider({
            endpoints: [{ url: TEST_RPC_URL, weight: 1 }],
            logChunkSize: 20,
            retryPolicy: TEST_RETRY_POLICY,
            resilience: TEST_RESILIENCE,
        });
        expect(
            (await provider.findFirstLogPage(MINT_FILTER)).log?.blockNumber,
        ).toBe(12);
        expect(request.method).toBe("eth_getLogs");
        expect(request.params[0]).toEqual({
            address: TEST_ADDRESS,
            fromBlock: "0x0",
            toBlock: "0x13",
            topics: [topics[0], topics[1], null, topics[3]],
        });
    });

    it("subdivides a rejected interval, visits pages in order, and stops at the first page containing the token's mint", async () => {
        const requests: number[][] = [];
        const provider = providerWith(async (params) => {
            const from = Number(params.fromBlock);
            const to = Number(params.toBlock);
            requests.push([from, to]);
            if (to - from + 1 > 2) throw new Error("block range is too wide");
            return [9, 5]
                .filter((block) => block >= from && block <= to)
                .map((block) => ({
                    ...rawLog(block),
                    blockNumber: BigInt(block),
                    logIndex: 0n,
                }));
        });
        const ranges: number[][] = [];
        let nextBlock = 0;
        let mintBlock: number | undefined;
        while (mintBlock === undefined) {
            const page = await provider.findFirstLogPage(
                { ...MINT_FILTER, fromBlock: nextBlock, toBlock: 10 },
                {
                    onRequest: (range) =>
                        ranges.push([range.fromBlock, range.toBlock]),
                },
            );
            nextBlock = page.nextBlock;
            mintBlock = page.log?.blockNumber;
        }
        expect(mintBlock).toBe(5);
        expect(requests).toEqual([
            [0, 7],
            [0, 3],
            [0, 1],
            [2, 3],
            [4, 5],
        ]);
        expect(ranges).toEqual(requests);
    });

    it("returns an empty bounded page with the next cursor", async () => {
        expect(
            await providerWith(async () => []).findFirstLogPage(MINT_FILTER),
        ).toEqual({ log: null, nextBlock: 8 });
    });

    it("checks cancellation before each smaller interval", async () => {
        const requests: number[][] = [];
        const stopped = new RpcRequestCancelledError();
        const provider = providerWith(async ({ fromBlock, toBlock }) => {
            requests.push([Number(fromBlock), Number(toBlock)]);
            throw new Error("block range is too wide");
        });
        await expect(
            provider.findFirstLogPage(MINT_FILTER, {
                onRequest: ({ toBlock }) => {
                    if (toBlock < 7) throw stopped;
                },
            }),
        ).rejects.toBe(stopped);
        expect(requests).toEqual([[0, 7]]);
    });

    it("halves timed-out pages immediately and retains the learned cap", async () => {
        const requests: number[][] = [];
        const provider = providerWith(async ({ fromBlock, toBlock }) => {
            requests.push([Number(fromBlock), Number(toBlock)]);
            if (toBlock - fromBlock + 1n > 2n)
                throw new BaseError("getLogs failed", {
                    cause: new RpcRequestTimeoutError(10),
                });
            return [];
        });
        expect(await provider.findFirstLogPage(MINT_FILTER)).toEqual({
            log: null,
            nextBlock: 2,
        });
        expect(
            await provider.findFirstLogPage({ ...MINT_FILTER, fromBlock: 2 }),
        ).toEqual({ log: null, nextBlock: 4 });
        await expect(
            provider.getLogs({ ...MINT_FILTER, fromBlock: 4, toBlock: 7 }),
        ).resolves.toEqual([]);
        // failureThreshold is one: a healthy endpoint must not be demoted or
        // circuit-opened by the requests this caller can recover by resizing.
        expect(requests).toEqual([
            [0, 7],
            [0, 3],
            [0, 1],
            [2, 3],
            [4, 5],
            [6, 7],
        ]);
    });

    it("retains endpoint failover when a single-block mint page times out", async () => {
        const requests: Array<{
            url: string;
            fromBlock: bigint;
            toBlock: bigint;
        }> = [];
        const provider = new ViemRpcProvider({
            endpoints: [
                { url: TEST_RPC_URL, weight: 1 },
                { url: TEST_BACKUP_RPC_URL, weight: 1 },
            ],
            logChunkSize: 8,
            resilience: TEST_RESILIENCE,
            retryPolicy: TEST_RETRY_POLICY,
            createClient: (url) =>
                ({
                    getLogs: async ({ fromBlock, toBlock }: LogRequest) => {
                        requests.push({ url, fromBlock, toBlock });
                        if (url === TEST_RPC_URL)
                            throw new RpcRequestTimeoutError(10);
                        return [];
                    },
                }) as unknown as ReturnType<ViemRpcClientFactory>,
        });
        await expect(
            provider.findFirstLogPage({ ...MINT_FILTER, toBlock: 0 }),
        ).resolves.toEqual({ log: null, nextBlock: 1 });
        expect(requests).toEqual([
            { url: TEST_RPC_URL, fromBlock: 0n, toBlock: 0n },
            { url: TEST_BACKUP_RPC_URL, fromBlock: 0n, toBlock: 0n },
        ]);
    });

    it("rechecks cancellation after quota admission and sends no request", async () => {
        const getLogs = vi.fn(async () => []);
        let active = true;
        const provider = new ViemRpcProvider({
            endpoints: [{ url: TEST_RPC_URL, weight: 1 }],
            logChunkSize: 8,
            resilience: TEST_RESILIENCE,
            retryPolicy: TEST_RETRY_POLICY,
            createClient: () =>
                ({ getLogs }) as unknown as ReturnType<ViemRpcClientFactory>,
            requestBudget: {
                budget: {
                    run: async (_input, run) => {
                        active = false;
                        return run();
                    },
                },
                workClass: () => SYNC_WORK_CLASS.Main,
            },
        });
        await expect(
            provider.findFirstLogPage(MINT_FILTER, {
                beforeRequest: () => {
                    if (!active) throw new RpcRequestCancelledError();
                },
            }),
        ).rejects.toBeInstanceOf(RpcRequestCancelledError);
        expect(getLogs).not.toHaveBeenCalled();
    });

    it("stops a retry when the caller loses ownership after the first request", async () => {
        let active = true;
        const getLogs = vi.fn(async () => {
            active = false;
            throw new Error("connection lost");
        });
        await expect(
            providerWith(getLogs).findFirstLogPage(MINT_FILTER, {
                beforeRequest: () => {
                    if (!active) throw new RpcRequestCancelledError();
                },
            }),
        ).rejects.toBeInstanceOf(RpcRequestCancelledError);
        expect(getLogs).toHaveBeenCalledTimes(1);
    });

    it("propagates unavailable log history without treating it as an empty interval", async () => {
        await expect(
            providerWith(async () => {
                throw new Error("historical logs unavailable");
            }).findFirstLogPage(MINT_FILTER),
        ).rejects.toThrow();
    });

    it.each([
        TEST_RESPONSE_LIMIT_BYTES,
        524_288,
        TEST_RESPONSE_LIMIT_BYTES * 2,
    ])(
        "recovers at the configured %i-byte viem limit and reuses the smaller cap",
        async (maxResponseBodySizeBytes) => {
            const requests: number[][] = [];
            vi.stubGlobal(
                "fetch",
                vi.fn(async (_url, init) => {
                    const body = JSON.parse(init.body);
                    const { fromBlock, toBlock } = body.params[0];
                    const from = Number(fromBlock);
                    const to = Number(toBlock);
                    requests.push([from, to]);
                    if (to - from + 1 > 2) {
                        // Trigger viem's actual Content-Length rejection without
                        // allocating a large body or replacing its error handling.
                        return new Response("", {
                            headers: {
                                "Content-Length": String(
                                    maxResponseBodySizeBytes + 1,
                                ),
                            },
                        });
                    }
                    return new Response(
                        JSON.stringify({
                            jsonrpc: "2.0",
                            id: body.id,
                            result: Array.from(
                                { length: to - from + 1 },
                                (_, i) => rawLog(from + i),
                            ),
                        }),
                        { headers: { "Content-Type": "application/json" } },
                    );
                }),
            );
            const provider = new ViemRpcProvider({
                endpoints: [{ url: TEST_RPC_URL, weight: 1 }],
                logChunkSize: 100,
                retryPolicy: TEST_RETRY_POLICY,
                resilience: { ...TEST_RESILIENCE, maxResponseBodySizeBytes },
            });

            const logs = await provider.getLogs({
                address: TEST_ADDRESS,
                fromBlock: 1,
                toBlock: 10,
            });
            expect(logs.map(({ blockNumber }) => blockNumber)).toEqual([
                1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
            ]);
            expect(requests).toEqual([
                [1, 10],
                [1, 5],
                [1, 2],
                [3, 4],
                [5, 6],
                [7, 8],
                [9, 10],
            ]);
            expect(logger.error).toHaveBeenCalledWith(
                INDEXER_RPC_LOG_MESSAGE.LogRangeReduced,
                expect.objectContaining({
                    action: INDEXER_RPC_LOG_ACTION.LogResponseSizeLimitExceeded,
                    requestedBlockCount: 5,
                    effectiveChunkSize: 2,
                    maxResponseBodySize: maxResponseBodySizeBytes,
                    responseBodySize: maxResponseBodySizeBytes + 1,
                }),
            );

            const laterLogs = await provider.getLogs({
                fromBlock: 11,
                toBlock: 15,
            });
            expect(laterLogs.map(({ blockNumber }) => blockNumber)).toEqual([
                11, 12, 13, 14, 15,
            ]);
            expect(requests.slice(7)).toEqual([
                [11, 12],
                [13, 14],
                [15, 15],
            ]);
        },
    );

    it("keeps completed chunks when an odd tail needs repeated subdivision", async () => {
        const requests: number[][] = [];
        const provider = providerWith(async (params) => {
            const from = Number(params.fromBlock);
            const to = Number(params.toBlock);
            requests.push([from, to]);
            if (from >= 9 && to > from) {
                throw new BaseError("getLogs failed", { cause: sizeError() });
            }
            return logsForRange(params);
        });

        const logs = await provider.getLogs({ fromBlock: 1, toBlock: 15 });
        expect(logs.map(({ blockNumber }) => blockNumber)).toEqual(
            Array.from({ length: 15 }, (_, i) => i + 1),
        );
        expect(requests).toEqual([
            [1, 8],
            [9, 15],
            [9, 11],
            [9, 9],
            [10, 10],
            [11, 11],
            [12, 12],
            [13, 13],
            [14, 14],
            [15, 15],
        ]);
    });

    it("recovers when the streamed body crosses the byte limit without a Content-Length header", async () => {
        const requests: number[][] = [];
        const cancelBody = vi.fn();
        vi.stubGlobal(
            "fetch",
            vi.fn(async (_url, init) => {
                const request = JSON.parse(init.body);
                const from = Number(request.params[0].fromBlock);
                const to = Number(request.params[0].toBlock);
                requests.push([from, to]);
                if (from !== to) {
                    return new Response(
                        new ReadableStream({
                            start(controller) {
                                controller.enqueue(
                                    new Uint8Array(
                                        TEST_RESPONSE_LIMIT_BYTES + 1,
                                    ),
                                );
                            },
                            cancel: cancelBody,
                        }),
                    );
                }
                return new Response(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: request.id,
                        result: [],
                    }),
                    { headers: { "Content-Type": "application/json" } },
                );
            }),
        );
        const provider = new ViemRpcProvider({
            endpoints: [{ url: TEST_RPC_URL, weight: 1 }],
            logChunkSize: 100,
            retryPolicy: TEST_RETRY_POLICY,
            resilience: TEST_RESILIENCE,
        });

        await expect(
            provider.getLogs({ fromBlock: 1, toBlock: 2 }),
        ).resolves.toEqual([]);
        expect(requests).toEqual([
            [1, 2],
            [1, 1],
            [2, 2],
        ]);
        expect(cancelBody).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
            INDEXER_RPC_LOG_MESSAGE.LogRangeReduced,
            expect.objectContaining({
                responseBodySize: TEST_RESPONSE_LIMIT_BYTES + 1,
                effectiveChunkSize: 1,
            }),
        );
    });

    it("does not raise the learned cap when an older concurrent request fails later", async () => {
        let rejectOlder!: (error: unknown) => void;
        const olderResponse = new Promise<unknown[]>((_resolve, reject) => {
            rejectOlder = reject;
        });
        const requests: number[][] = [];
        const provider = providerWith(async (params) => {
            const from = Number(params.fromBlock);
            const to = Number(params.toBlock);
            requests.push([from, to]);
            if (from === 1 && to === 8) return olderResponse;
            if (to - from + 1 > 2) throw sizeError();
            return logsForRange(params);
        });

        const older = provider.getLogs({ fromBlock: 1, toBlock: 8 });
        const newer = await provider.getLogs({ fromBlock: 101, toBlock: 108 });
        rejectOlder(sizeError());
        const olderLogs = await older;
        expect(newer.map(({ blockNumber }) => blockNumber)).toEqual([
            101, 102, 103, 104, 105, 106, 107, 108,
        ]);
        expect(olderLogs.map(({ blockNumber }) => blockNumber)).toEqual([
            1, 2, 3, 4, 5, 6, 7, 8,
        ]);
        expect(requests.filter(([from]) => from < 100)).toEqual([
            [1, 8],
            [1, 2],
            [3, 4],
            [5, 6],
            [7, 8],
        ]);
    });

    it("advances past a successful in-flight interval even if another request lowers the cap", async () => {
        let completeOlder!: (logs: unknown[]) => void;
        const olderResponse = new Promise<unknown[]>((resolve) => {
            completeOlder = resolve;
        });
        const requests: number[][] = [];
        const provider = providerWith(async (params) => {
            const from = Number(params.fromBlock);
            const to = Number(params.toBlock);
            requests.push([from, to]);
            if (from === 1 && to === 8) return olderResponse;
            if (from >= 100 && to - from + 1 > 2) throw sizeError();
            return logsForRange(params);
        });

        const older = provider.getLogs({ fromBlock: 1, toBlock: 12 });
        await provider.getLogs({ fromBlock: 101, toBlock: 108 });
        completeOlder(logsForRange({ fromBlock: 1n, toBlock: 8n }));
        const olderLogs = await older;
        expect(olderLogs.map(({ blockNumber }) => blockNumber)).toEqual(
            Array.from({ length: 12 }, (_, i) => i + 1),
        );
        expect(requests.filter(([from]) => from < 100)).toEqual([
            [1, 8],
            [9, 10],
            [11, 12],
        ]);
    });

    it("stops at a single oversized block without retries or circuit poisoning", async () => {
        const error = sizeError();
        const getLogs = vi.fn(async (params: LogRequest) => {
            if (params.fromBlock === 7n) throw error;
            return logsForRange(params);
        });
        const provider = providerWith(getLogs);
        await expect(
            provider.getLogs({ fromBlock: 7, toBlock: 7 }),
        ).rejects.toBe(error);
        expect(getLogs).toHaveBeenCalledTimes(1);
        expect(logger.error).toHaveBeenCalledWith(
            INDEXER_RPC_LOG_MESSAGE.SingleBlockResponseTooLarge,
            expect.objectContaining({ effectiveChunkSize: 1 }),
        );
        await expect(
            provider.getLogs({ fromBlock: 8, toBlock: 8 }),
        ).resolves.toHaveLength(1);
        expect(getLogs).toHaveBeenCalledTimes(2);
    });

    it("keeps transient endpoint retries and the configured range size", async () => {
        const getLogs = vi.fn(async (params: LogRequest) =>
            logsForRange(params),
        );
        getLogs.mockRejectedValueOnce(new Error("temporary endpoint failure"));
        const provider = new ViemRpcProvider({
            endpoints: [{ url: TEST_RPC_URL, weight: 1 }],
            logChunkSize: 8,
            retryPolicy: TEST_RETRY_POLICY,
            resilience: {
                ...TEST_RESILIENCE,
                circuitBreaker: {
                    ...TEST_RESILIENCE.circuitBreaker,
                    failureThreshold: 10,
                },
            },
            createClient: () =>
                ({ getLogs }) as unknown as ReturnType<ViemRpcClientFactory>,
        });
        await expect(
            provider.getLogs({ fromBlock: 1, toBlock: 8 }),
        ).resolves.toHaveLength(8);
        expect(getLogs).toHaveBeenCalledTimes(2);
        for (const [params] of getLogs.mock.calls) {
            expect(params).toEqual(
                expect.objectContaining({ fromBlock: 1n, toBlock: 8n }),
            );
        }
        expect(logger.error).not.toHaveBeenCalled();
    });
});
