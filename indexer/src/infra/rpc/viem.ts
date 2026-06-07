import { createPublicClient, http } from "viem";
import {
    getDefaultRpcEndpointResilienceConfig,
    getDefaultRpcRetryPolicy,
} from "@artgod/shared/config/rpc-resilience";
import type { RpcEndpointConfig } from "@artgod/shared/config/rpc-endpoints";
import { WeightedEndpointSelector } from "@artgod/shared/config/weighted-endpoints";
import { executeObservedRpcEndpointCall } from "@artgod/shared/evm/rpc-execution";
import {
    CircuitBreaker,
    type RpcEndpointResilienceConfig,
    type RpcRetryPolicy,
    TokenBucketRateLimiter,
} from "@artgod/shared/evm/rpc-resilience";
import type { Metrics } from "@artgod/shared/observability/metrics";
import {
    RPC_OBSERVABILITY_WORKSPACE,
    RPC_PROTOCOL,
    RpcObservability,
} from "@artgod/shared/observability/rpc";
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
    INDEXER_RPC_ENDPOINT_ID_PREFIX,
    INDEXER_RPC_LOG_COMPONENT,
    INDEXER_RPC_OBSERVABILITY_COMPONENT,
} from "./observability.js";

export type ViemRpcConfig = {
    endpoints: RpcEndpointConfig[];
    logChunkSize: number;
    cache?: CachePort;
    metrics?: Metrics;
    component?: string;
    endpointIdPrefix?: string;
    retryPolicy?: RpcRetryPolicy;
    resilience?: RpcEndpointResilienceConfig;
    createClient?: ViemRpcClientFactory;
};

type ViemPublicClient = ReturnType<typeof createPublicClient>;

// Factory hook for injecting viem clients while this adapter owns RPC resilience.
export type ViemRpcClientFactory = (url: string) => ViemPublicClient;

type ViemRpcEndpoint = {
    client: ViemPublicClient;
    rateLimiter: TokenBucketRateLimiter;
    circuitBreaker: CircuitBreaker;
};

const DEFAULT_RETRY_POLICY = getDefaultRpcRetryPolicy();
const DEFAULT_RESILIENCE = getDefaultRpcEndpointResilienceConfig();

export class ViemRpcProvider implements RpcProviderPort {
    private cache?: CachePort;
    private retryPolicy: RpcRetryPolicy;
    private endpointSelector: WeightedEndpointSelector<ViemRpcEndpoint>;
    private rpcObservability: RpcObservability;
    private rpcComponent: string;

    constructor(private config: ViemRpcConfig) {
        const endpoints = resolveRpcEndpoints(config);
        this.rpcComponent =
            config.component ?? INDEXER_RPC_OBSERVABILITY_COMPONENT.DefaultHttp;
        const endpointIdPrefix =
            config.endpointIdPrefix ??
            INDEXER_RPC_ENDPOINT_ID_PREFIX.DefaultHttp;
        const resilience = config.resilience ?? DEFAULT_RESILIENCE;
        const createClient =
            config.createClient ??
            ((url) => createViemRpcClient(url, resilience.requestTimeoutMs));
        this.endpointSelector = new WeightedEndpointSelector(
            endpoints.map((endpoint, index) => ({
                ...endpoint,
                id: `${endpointIdPrefix}-${index + 1}`,
                value: {
                    client: createClient(endpoint.url),
                    rateLimiter: new TokenBucketRateLimiter(
                        resilience.rateLimiter,
                    ),
                    circuitBreaker: new CircuitBreaker(
                        resilience.circuitBreaker,
                    ),
                },
            })),
        );
        this.cache = config.cache;
        this.retryPolicy = config.retryPolicy ?? DEFAULT_RETRY_POLICY;
        this.rpcObservability = new RpcObservability({
            workspace: RPC_OBSERVABILITY_WORKSPACE.Indexer,
            component: this.rpcComponent,
            protocol: RPC_PROTOCOL.Http,
            metrics: config.metrics,
            logComponent: INDEXER_RPC_LOG_COMPONENT.Http,
        });
        for (const endpoint of this.endpointSelector.snapshot()) {
            this.rpcObservability.recordConfiguredEndpoint(endpoint);
        }
    }

    async getBlockNumber(): Promise<number> {
        const value = await this.executeRpc("getBlockNumber", (client) =>
            client.getBlockNumber(),
        );
        return toSafeNumber(value, "blockNumber");
    }

    async getBlock(blockNumber: number): Promise<RpcBlock> {
        const cached = this.cache?.get<RpcBlock>("block", String(blockNumber));
        if (cached) return cached;

        const block = await this.executeRpc("getBlock", (client) =>
            client.getBlock({
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

        const tx = await this.executeRpc("getTransaction", (client) =>
            client.getTransaction({
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

        const receipt = await this.executeRpc(
            "getTransactionReceipt",
            (client) =>
                client.getTransactionReceipt({
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
            const chunk = await this.executeRpc("getLogs", (client) =>
                client.getLogs(params as any),
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
        const result = await this.executeRpc("readContract", (client) =>
            client.readContract({
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
        return this.executeRpc("getBalance", (client) =>
            client.getBalance({
                address: address as `0x${string}`,
            }),
        );
    }

    private async executeRpc<T>(
        method: string,
        fn: (client: ViemPublicClient) => Promise<T>,
    ): Promise<T> {
        return executeObservedRpcEndpointCall({
            selector: this.endpointSelector,
            method,
            rpcObservability: this.rpcObservability,
            retryPolicy: this.retryPolicy,
            circuitBreaker: (endpoint) => endpoint.value.circuitBreaker,
            rateLimiter: (endpoint) => endpoint.value.rateLimiter,
            execute: (endpoint) => fn(endpoint.value.client),
        });
    }
}

function resolveRpcEndpoints(config: ViemRpcConfig): RpcEndpointConfig[] {
    if (config.endpoints.length > 0) {
        return config.endpoints;
    }
    throw new Error("At least one RPC endpoint URL is required");
}

function createViemRpcClient(
    url: string,
    requestTimeoutMs: number,
): ViemPublicClient {
    return createPublicClient({
        transport: http(url, {
            timeout: requestTimeoutMs,
        }),
    });
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
