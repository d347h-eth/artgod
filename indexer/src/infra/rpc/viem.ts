import { createPublicClient, http } from "viem";
import { getSettingDefaultNumber } from "@artgod/shared/config/generated-settings-defaults";
import type { RetryPolicy } from "../../domain/retry.js";
import { getRetryDelayMs } from "../../domain/retry.js";
import type { Metrics } from "@artgod/shared/observability/metrics";
import type { CachePort } from "../../ports/cache.js";
import type {
    Hex,
    RpcBlock,
    RpcLog,
    RpcLogFilter,
    RpcProviderPort,
    RpcTransaction,
    RpcTransactionReceipt,
} from "../../ports/rpc.js";
import {
    CircuitBreaker,
    CircuitOpenError,
    type RpcCircuitBreakerConfig,
    type RpcRateLimiterConfig,
    TokenBucketRateLimiter,
} from "./resilience.js";

export type ViemRpcConfig = {
    url: string;
    logChunkSize: number;
    cache?: CachePort;
    metrics?: Metrics;
    retryPolicy?: RetryPolicy;
    resilience?: {
        rateLimiter: RpcRateLimiterConfig;
        circuitBreaker: RpcCircuitBreakerConfig;
    };
};

const DEFAULT_RETRY_POLICY: RetryPolicy = {
    maxAttempts: getSettingDefaultNumber("RPC_RETRY_MAX_ATTEMPTS"),
    baseDelayMs: getSettingDefaultNumber("RPC_RETRY_BASE_DELAY_MS"),
    maxDelayMs: getSettingDefaultNumber("RPC_RETRY_MAX_DELAY_MS"),
};

const DEFAULT_RATE_LIMITER: RpcRateLimiterConfig = {
    requestsPerSecond: getSettingDefaultNumber(
        "RPC_RATE_LIMIT_REQUESTS_PER_SECOND",
    ),
    burst: getSettingDefaultNumber("RPC_RATE_LIMIT_BURST"),
};

const DEFAULT_CIRCUIT_BREAKER: RpcCircuitBreakerConfig = {
    failureThreshold: getSettingDefaultNumber(
        "RPC_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
    ),
    openMs: getSettingDefaultNumber("RPC_CIRCUIT_BREAKER_OPEN_MS"),
    halfOpenMaxRequests: getSettingDefaultNumber(
        "RPC_CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS",
    ),
};

export class ViemRpcProvider implements RpcProviderPort {
    private client: ReturnType<typeof createPublicClient>;
    private cache?: CachePort;
    private metrics?: Metrics;
    private retryPolicy: RetryPolicy;
    private rateLimiter: TokenBucketRateLimiter;
    private circuitBreaker: CircuitBreaker;

    constructor(private config: ViemRpcConfig) {
        this.client = createPublicClient({
            transport: http(this.config.url),
        });
        this.cache = config.cache;
        this.metrics = config.metrics;
        this.retryPolicy = config.retryPolicy ?? DEFAULT_RETRY_POLICY;
        this.rateLimiter = new TokenBucketRateLimiter(
            config.resilience?.rateLimiter ?? DEFAULT_RATE_LIMITER,
        );
        this.circuitBreaker = new CircuitBreaker(
            config.resilience?.circuitBreaker ?? DEFAULT_CIRCUIT_BREAKER,
        );
    }

    async getBlockNumber(): Promise<number> {
        const value = await this.executeRpc("getBlockNumber", () =>
            this.client.getBlockNumber(),
        );
        return toSafeNumber(value, "blockNumber");
    }

    async getBlock(blockNumber: number): Promise<RpcBlock> {
        const cached = this.cache?.get<RpcBlock>("block", String(blockNumber));
        if (cached) return cached;

        const block = await this.executeRpc("getBlock", () =>
            this.client.getBlock({
                blockNumber: BigInt(blockNumber),
            }),
        );

        const mapped: RpcBlock = {
            number: toSafeNumber(
                block.number ?? BigInt(blockNumber),
                "block.number",
            ),
            hash: (block.hash ?? "0x") as Hex,
            parentHash: (block.parentHash ?? "0x") as Hex,
            timestamp: toSafeNumber(block.timestamp, "block.timestamp"),
            transactions: block.transactions.map((tx) => String(tx) as Hex),
        };

        this.cache?.set("block", String(blockNumber), mapped);
        return mapped;
    }

    async getTransaction(txHash: string): Promise<RpcTransaction> {
        const cached = this.cache?.get<RpcTransaction>("tx", txHash);
        if (cached) return cached;

        const tx = await this.executeRpc("getTransaction", () =>
            this.client.getTransaction({
                hash: txHash as `0x${string}`,
            }),
        );

        const mapped: RpcTransaction = {
            hash: tx.hash as Hex,
            from: tx.from as Hex,
            to: (tx.to ?? null) as Hex | null,
            input: tx.input as Hex,
        };

        this.cache?.set("tx", txHash, mapped);
        return mapped;
    }

    async getTransactionReceipt(
        txHash: string,
    ): Promise<RpcTransactionReceipt> {
        const cached = this.cache?.get<RpcTransactionReceipt>(
            "receipt",
            txHash,
        );
        if (cached) return cached;

        const receipt = await this.executeRpc("getTransactionReceipt", () =>
            this.client.getTransactionReceipt({
                hash: txHash as `0x${string}`,
            }),
        );

        const mapped: RpcTransactionReceipt = {
            transactionHash: receipt.transactionHash as Hex,
            logs: receipt.logs.map(mapLog),
        };

        this.cache?.set("receipt", txHash, mapped);
        return mapped;
    }

    async getLogs(filter: RpcLogFilter): Promise<RpcLog[]> {
        if (filter.fromBlock > filter.toBlock) return [];

        const logs: RpcLog[] = [];
        const chunkSize = Math.max(1, this.config.logChunkSize);
        for (
            let start = filter.fromBlock;
            start <= filter.toBlock;
            start += chunkSize
        ) {
            const end = Math.min(filter.toBlock, start + chunkSize - 1);
            const params = {
                address: filter.address as any,
                events: filter.events as any,
                fromBlock: BigInt(start),
                toBlock: BigInt(end),
            };
            const chunk = await this.executeRpc("getLogs", () =>
                this.client.getLogs(params as any),
            );
            logs.push(...chunk.map(mapLog));
        }
        return logs;
    }

    async readContract<T>(params: {
        address: Hex;
        abi: readonly unknown[];
        functionName: string;
        args?: readonly unknown[];
        blockNumber?: number;
    }): Promise<T> {
        const result = await this.executeRpc("readContract", () =>
            this.client.readContract({
                address: params.address as `0x${string}`,
                abi: params.abi as any,
                functionName: params.functionName as any,
                args: params.args as any,
                blockNumber:
                    params.blockNumber !== undefined
                        ? BigInt(params.blockNumber)
                        : undefined,
            }),
        );
        return result as T;
    }

    async getBalance(address: Hex): Promise<bigint> {
        return this.executeRpc("getBalance", () =>
            this.client.getBalance({
                address: address as `0x${string}`,
            }),
        );
    }

    private async executeRpc<T>(
        method: string,
        fn: () => Promise<T>,
    ): Promise<T> {
        const start = Date.now();
        try {
            const result = await this.circuitBreaker.execute(() =>
                this.withRetry(() => this.withRateLimit(method, fn), method),
            );
            this.metrics?.histogram("rpc.latency", Date.now() - start, {
                method,
            });
            return result;
        } catch (error) {
            if (error instanceof CircuitOpenError) {
                this.metrics?.increment("rpc.circuit_open", 1, { method });
            }
            this.metrics?.increment("rpc.failure", 1, { method });
            throw error;
        }
    }

    private async withRateLimit<T>(
        method: string,
        fn: () => Promise<T>,
    ): Promise<T> {
        const waitedMs = await this.rateLimiter.acquire();
        if (waitedMs > 0) {
            this.metrics?.histogram("rpc.rate_limiter.wait_ms", waitedMs, {
                method,
            });
        }
        return fn();
    }

    private async withRetry<T>(
        fn: () => Promise<T>,
        method: string,
    ): Promise<T> {
        let attempt = 1;
        for (;;) {
            try {
                return await fn();
            } catch (err) {
                if (attempt >= this.retryPolicy.maxAttempts) {
                    throw err;
                }
                const delay = getRetryDelayMs(attempt, this.retryPolicy);
                this.metrics?.increment("rpc.retry", 1, { attempt, method });
                await sleep(delay);
                attempt += 1;
            }
        }
    }
}

function mapLog(log: any): RpcLog {
    return {
        address: (log.address ?? "0x") as Hex,
        data: (log.data ?? "0x") as Hex,
        topics: (log.topics ?? []) as Hex[],
        blockNumber: toSafeNumber(log.blockNumber ?? 0n, "log.blockNumber"),
        blockHash: (log.blockHash ?? "0x") as Hex,
        transactionHash: (log.transactionHash ?? "0x") as Hex,
        logIndex: toSafeNumber(log.logIndex ?? 0n, "log.logIndex"),
    };
}

function toSafeNumber(value: bigint, label: string): number {
    const num = Number(value);
    if (!Number.isSafeInteger(num)) {
        throw new Error(`${label} exceeds JS safe integer: ${String(value)}`);
    }
    return num;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
