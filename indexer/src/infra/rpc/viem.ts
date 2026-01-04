import { createPublicClient, http } from "viem";
import type { Metrics } from "../../metrics/types.js";
import type { CachePort } from "../../ports/cache.js";
import type {
    RpcBlock,
    RpcLog,
    RpcLogFilter,
    RpcProviderPort,
    RpcTransaction,
} from "../../ports/rpc.js";
import type { RetryPolicy } from "../../domain/retry.js";
import { defaultRetryPolicy, getRetryDelayMs } from "../../domain/retry.js";

export type ViemRpcConfig = {
    url: string;
    logChunkSize: number;
    cache?: CachePort;
    metrics?: Metrics;
    retryPolicy?: RetryPolicy;
};

export class ViemRpcProvider implements RpcProviderPort {
    private client = createPublicClient({
        transport: http(this.config.url),
    });
    private cache?: CachePort;
    private metrics?: Metrics;
    private retryPolicy: RetryPolicy;

    constructor(private config: ViemRpcConfig) {
        this.cache = config.cache;
        this.metrics = config.metrics;
        this.retryPolicy = config.retryPolicy ?? defaultRetryPolicy;
    }

    async getBlockNumber(): Promise<number> {
        const start = Date.now();
        const value = await this.client.getBlockNumber();
        this.metrics?.histogram("rpc.latency", Date.now() - start, {
            method: "getBlockNumber",
        });
        return toSafeNumber(value, "blockNumber");
    }

    async getBlock(blockNumber: number): Promise<RpcBlock> {
        const cached = this.cache?.get<RpcBlock>("block", String(blockNumber));
        if (cached) return cached;

        const start = Date.now();
        const block = await this.client.getBlock({
            blockNumber: BigInt(blockNumber),
        });
        this.metrics?.histogram("rpc.latency", Date.now() - start, {
            method: "getBlock",
        });

        const mapped: RpcBlock = {
            number: toSafeNumber(block.number ?? BigInt(blockNumber), "block.number"),
            hash: block.hash ?? "",
            parentHash: block.parentHash ?? "",
            timestamp: toSafeNumber(block.timestamp, "block.timestamp"),
            transactions: block.transactions.map((tx) => String(tx)),
        };

        this.cache?.set("block", String(blockNumber), mapped);
        return mapped;
    }

    async getTransaction(txHash: string): Promise<RpcTransaction> {
        const cached = this.cache?.get<RpcTransaction>("tx", txHash);
        if (cached) return cached;

        const start = Date.now();
        const tx = await this.client.getTransaction({ hash: txHash as `0x${string}` });
        this.metrics?.histogram("rpc.latency", Date.now() - start, {
            method: "getTransaction",
        });

        const mapped: RpcTransaction = {
            hash: tx.hash,
            from: tx.from,
            to: tx.to ?? null,
            input: tx.input,
        };

        this.cache?.set("tx", txHash, mapped);
        return mapped;
    }

    async getLogs(filter: RpcLogFilter): Promise<RpcLog[]> {
        if (filter.fromBlock > filter.toBlock) return [];

        const logs: RpcLog[] = [];
        const chunkSize = Math.max(1, this.config.logChunkSize);
        for (let start = filter.fromBlock; start <= filter.toBlock; start += chunkSize) {
            const end = Math.min(filter.toBlock, start + chunkSize - 1);
            const chunk = await this.withRetry(() =>
                this.client.getLogs({
                    address: filter.address as any,
                    topics: filter.topics as any,
                    fromBlock: BigInt(start),
                    toBlock: BigInt(end),
                }),
            );
            logs.push(...chunk.map(mapLog));
        }
        return logs;
    }

    private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
        let attempt = 1;
        for (;;) {
            try {
                return await fn();
            } catch (err) {
                if (attempt >= this.retryPolicy.maxAttempts) {
                    throw err;
                }
                const delay = getRetryDelayMs(attempt, this.retryPolicy);
                this.metrics?.increment("rpc.retry", 1, { attempt });
                await sleep(delay);
                attempt += 1;
            }
        }
    }
}

function mapLog(log: any): RpcLog {
    return {
        address: log.address,
        data: log.data,
        topics: log.topics ?? [],
        blockNumber: toSafeNumber(log.blockNumber ?? 0n, "log.blockNumber"),
        blockHash: log.blockHash ?? "",
        transactionHash: log.transactionHash ?? "",
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
