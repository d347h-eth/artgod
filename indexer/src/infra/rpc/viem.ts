import {
    BaseError,
    createPublicClient,
    decodeFunctionResult,
    encodeFunctionData,
    getContractError,
    type Abi,
} from "viem";
import {
    getRpcResponseBodySizeLimit,
    isRpcDeterministicContractError,
    RPC_RESPONSE_BODY_TOO_LARGE_ERROR_CLASS_NAME,
} from "@artgod/shared/evm/rpc-errors";
import {
    getDefaultRpcEndpointResilienceConfig,
    getDefaultRpcRetryPolicy,
} from "@artgod/shared/config/rpc-resilience";
import type { RpcEndpointConfig } from "@artgod/shared/config/rpc-endpoints";
import { WeightedEndpointSelector } from "@artgod/shared/config/weighted-endpoints";
import { executeObservedRpcEndpointCall } from "@artgod/shared/evm/rpc-execution";
import {
    rpcEndpointBudgetKey,
    type RpcRequestBudget,
} from "@artgod/shared/evm/rpc-budget";
import type { SyncWorkClass } from "@artgod/shared/types/sync-work-class";
import { createHttpRpcTransport } from "@artgod/shared/evm/http-rpc-transport";
import {
    CircuitBreaker,
    type RpcEndpointResilienceConfig,
    type RpcRetryPolicy,
    TokenBucketRateLimiter,
    VIEM_TRANSPORT_RETRY_DISABLED,
} from "@artgod/shared/evm/rpc-resilience";
import type { Metrics } from "@artgod/shared/observability/metrics";
import { logger } from "@artgod/shared/utils/logger";
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
import { RPC_CONTRACT_BATCH_MAX_CALLS } from "../../ports/rpc.js";
import {
    INDEXER_RPC_ENDPOINT_ID_PREFIX,
    INDEXER_RPC_LOG_ACTION,
    INDEXER_RPC_LOG_COMPONENT,
    INDEXER_RPC_LOG_MESSAGE,
    INDEXER_RPC_METHOD,
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
    requestBudget?: {
        budget: RpcRequestBudget;
        workClass: () => SyncWorkClass;
    };
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
    // A learned cap applies to subsequent and concurrent calls on this provider,
    // including retained jobs whose original block ranges cannot be rescheduled.
    private effectiveLogChunkSize: number;

    constructor(private config: ViemRpcConfig) {
        this.effectiveLogChunkSize = Math.max(
            1,
            Math.floor(config.logChunkSize),
        );
        const endpoints = resolveRpcEndpoints(config);
        this.rpcComponent =
            config.component ?? INDEXER_RPC_OBSERVABILITY_COMPONENT.DefaultHttp;
        const endpointIdPrefix =
            config.endpointIdPrefix ??
            INDEXER_RPC_ENDPOINT_ID_PREFIX.DefaultHttp;
        const resilience = config.resilience ?? DEFAULT_RESILIENCE;
        const createClient =
            config.createClient ??
            ((url) => createViemRpcClient(url, resilience));
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

    async getBlock(
        blockNumber: number,
        options?: { fresh: boolean },
    ): Promise<RpcBlock> {
        const cached = options?.fresh
            ? undefined
            : this.cache?.get<RpcBlock>("block", String(blockNumber));
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
        options?: { fresh: boolean },
    ): Promise<RpcTransactionReceipt> {
        const cached = options?.fresh
            ? undefined
            : this.cache?.get<RpcTransactionReceipt>("receipt", txHash);
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
        let start = filter.fromBlock;
        while (start <= filter.toBlock) {
            const end = Math.min(
                filter.toBlock,
                start + this.effectiveLogChunkSize - 1,
            );
            const params = {
                address: filter.address as any,
                events: filter.events as any,
                fromBlock: BigInt(start),
                toBlock: BigInt(end),
            };
            try {
                const chunk = await this.executeRpc(
                    INDEXER_RPC_METHOD.GetLogs,
                    (client) => client.getLogs(params as any),
                );
                logs.push(...chunk.map(mapLog));
                // Advance only after the exact interval succeeds, even when
                // another call reduced the shared cap while this one awaited RPC.
                start = end + 1;
            } catch (error) {
                const sizeLimit = getRpcResponseBodySizeLimit(error);
                if (!sizeLimit) throw error;

                const requestedBlockCount = end - start + 1;
                const previousChunkSize = this.effectiveLogChunkSize;
                // Concurrent failures can only lower the cap. Retrying the same
                // cursor with half the failed span bounds recovery at one block.
                this.effectiveLogChunkSize = Math.min(
                    previousChunkSize,
                    Math.max(1, Math.floor(requestedBlockCount / 2)),
                );
                logger.error(
                    requestedBlockCount > 1
                        ? INDEXER_RPC_LOG_MESSAGE.LogRangeReduced
                        : INDEXER_RPC_LOG_MESSAGE.SingleBlockResponseTooLarge,
                    {
                        component: INDEXER_RPC_LOG_COMPONENT.Http,
                        workspace: RPC_OBSERVABILITY_WORKSPACE.Indexer,
                        rpcComponent: this.rpcComponent,
                        protocol: RPC_PROTOCOL.Http,
                        method: INDEXER_RPC_METHOD.GetLogs,
                        action: INDEXER_RPC_LOG_ACTION.LogResponseSizeLimitExceeded,
                        errorClass:
                            RPC_RESPONSE_BODY_TOO_LARGE_ERROR_CLASS_NAME,
                        fromBlock: start,
                        toBlock: end,
                        requestedBlockCount,
                        configuredChunkSize: this.config.logChunkSize,
                        previousChunkSize,
                        effectiveChunkSize: this.effectiveLogChunkSize,
                        maxResponseBodySize: sizeLimit.maxSize,
                        responseBodySize: sizeLimit.size,
                    },
                );
                if (requestedBlockCount === 1) throw error;
            }
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

    async readContractAtBlock<T>(
        params: Parameters<RpcProviderPort["readContractAtBlock"]>[0],
    ): Promise<T> {
        const { block, ...contract } = params;
        if (
            !Number.isSafeInteger(block.chainId) ||
            block.chainId < 1 ||
            !Number.isSafeInteger(block.blockNumber) ||
            block.blockNumber < 0 ||
            !/^0x[0-9a-fA-F]{64}$/.test(block.blockHash)
        )
            throw new Error("Invalid exact-block contract read");
        const abi = contract.abi as Abi;
        const data = encodeFunctionData({
            abi,
            functionName: contract.functionName,
            args: contract.args,
        });
        return this.executeRpc("readContractAtBlock", async (client) => {
            try {
                // viem's readContract action accepts heights, not EIP-1898
                // selectors. Keep the raw call and decoded contract errors here.
                const result = await client.request(
                    {
                        method: "eth_call",
                        params: [
                            { to: contract.address, data },
                            {
                                blockHash: block.blockHash as Hex,
                                requireCanonical: true,
                            },
                        ],
                    },
                    { retryCount: VIEM_TRANSPORT_RETRY_DISABLED },
                );
                return decodeFunctionResult({
                    abi,
                    functionName: contract.functionName,
                    data: result,
                }) as T;
            } catch (error) {
                if (!(error instanceof BaseError)) throw error;
                throw getContractError(error, {
                    ...contract,
                    abi,
                    args: contract.args,
                });
            }
        });
    }

    async getBalance(
        address: Hex,
        options?: { blockNumber: number },
    ): Promise<bigint> {
        return this.executeRpc("getBalance", (client) =>
            client.getBalance({
                address: address as `0x${string}`,
                blockNumber: options ? BigInt(options.blockNumber) : undefined,
            }),
        );
    }

    async readContracts(
        input: Parameters<NonNullable<RpcProviderPort["readContracts"]>>[0],
    ) {
        if (
            input.contracts.length < 1 ||
            input.contracts.length > RPC_CONTRACT_BATCH_MAX_CALLS ||
            !Number.isSafeInteger(input.blockNumber) ||
            input.blockNumber < 0
        )
            throw new Error("Invalid bounded contract batch");
        return this.executeRpc("readContracts", async (client) => {
            const results = await client.multicall({
                contracts: input.contracts.map((contract) => ({
                    ...contract,
                    abi: contract.abi as Abi,
                })),
                blockNumber: BigInt(input.blockNumber),
                allowFailure: true,
                // A read-only eth_call works without assuming a deployed multicall address.
                deployless: true,
                // This port caps request count. Do not let viem fan out hidden parallel chunks.
                batchSize: 0,
            });
            // viem returns outer transport failures as per-item failures with allowFailure.
            // Surface them through our existing retry/rate/circuit/observability boundary.
            const first = results[0];
            if (
                first?.status === "failure" &&
                results.every(
                    (result) =>
                        result.status === "failure" &&
                        result.error === first.error,
                ) &&
                !isRpcDeterministicContractError(first.error)
            )
                // Keep bytecode/calldata out of the endpoint log message; classification
                // and retry still inspect the original SDK error through its cause.
                throw new Error("Aggregate contract read failed", {
                    cause: first.error,
                });
            return results.map((result) =>
                result.status === "success"
                    ? { value: result.result }
                    : { error: result.error },
            );
        });
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
            requestBudget: this.config.requestBudget
                ? {
                      ...this.config.requestBudget,
                      endpointKey: (endpoint) =>
                          rpcEndpointBudgetKey(endpoint.url),
                  }
                : undefined,
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
    resilience: RpcEndpointResilienceConfig,
): ViemPublicClient {
    return createPublicClient({
        transport: createHttpRpcTransport(url, resilience),
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
