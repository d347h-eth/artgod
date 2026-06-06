import { createPublicClient, http } from "viem";
import type { RpcEndpointConfig } from "@artgod/shared/config/rpc-endpoints";
import {
    WeightedEndpointSelector,
    type WeightedEndpointSelection,
} from "@artgod/shared/config/weighted-endpoints";
import { getSettingDefaultNumber } from "@artgod/shared/config/generated-settings-defaults";
import {
    CircuitBreaker,
    CircuitOpenError,
    executeWithRpcRetry,
    type RpcEndpointResilienceConfig,
    type RpcRetryPolicy,
    TokenBucketRateLimiter,
} from "@artgod/shared/evm/rpc-resilience";
import type { Metrics } from "@artgod/shared/observability/metrics";
import {
    RPC_OBSERVABILITY_WORKSPACE,
    RPC_PROTOCOL,
    RpcObservability,
    type RpcCallContext,
} from "@artgod/shared/observability/rpc";
import type { TokenStandard } from "../../domain/metadata.js";
import type { TokenUriResolverPort } from "../../ports/metadata.js";
import {
    INDEXER_METADATA_RPC_METRIC,
    INDEXER_METADATA_RPC_RESULT,
    INDEXER_RPC_ENDPOINT_ID_PREFIX,
    INDEXER_RPC_LOG_COMPONENT,
    INDEXER_RPC_METHOD,
    INDEXER_RPC_OBSERVABILITY_COMPONENT,
} from "../rpc/observability.js";

const ERC721_METADATA_ABI = [
    {
        type: "function",
        name: INDEXER_RPC_METHOD.TokenUri,
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "", type: "string" }],
    },
] as const;

const ERC1155_METADATA_ABI = [
    {
        type: "function",
        name: INDEXER_RPC_METHOD.Erc1155Uri,
        stateMutability: "view",
        inputs: [{ name: "id", type: "uint256" }],
        outputs: [{ name: "", type: "string" }],
    },
] as const;

export type TokenUriResolverConfig = {
    endpoints: RpcEndpointConfig[];
    metrics?: Metrics;
    component?: string;
    endpointIdPrefix?: string;
    retryPolicy?: RpcRetryPolicy;
    resilience?: RpcEndpointResilienceConfig;
    createClient?: TokenUriRpcClientFactory;
    sleep?: (ms: number) => Promise<void>;
};

export type TokenUriRpcClient = ReturnType<typeof createPublicClient>;
export type TokenUriRpcClientFactory = (url: string) => TokenUriRpcClient;
type TokenUriRpcEndpoint = {
    client: TokenUriRpcClient;
    rateLimiter: TokenBucketRateLimiter;
    circuitBreaker: CircuitBreaker;
};
type TokenUriRpcEndpointSelection =
    WeightedEndpointSelection<TokenUriRpcEndpoint>;

const DEFAULT_RETRY_POLICY: RpcRetryPolicy = {
    maxAttempts: getSettingDefaultNumber("RPC_RETRY_MAX_ATTEMPTS"),
    baseDelayMs: getSettingDefaultNumber("RPC_RETRY_BASE_DELAY_MS"),
    maxDelayMs: getSettingDefaultNumber("RPC_RETRY_MAX_DELAY_MS"),
};

const DEFAULT_RESILIENCE: RpcEndpointResilienceConfig = {
    rateLimiter: {
        requestsPerSecond: getSettingDefaultNumber(
            "RPC_RATE_LIMIT_REQUESTS_PER_SECOND",
        ),
        burst: getSettingDefaultNumber("RPC_RATE_LIMIT_BURST"),
    },
    circuitBreaker: {
        failureThreshold: getSettingDefaultNumber(
            "RPC_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
        ),
        openMs: getSettingDefaultNumber("RPC_CIRCUIT_BREAKER_OPEN_MS"),
        halfOpenMaxRequests: getSettingDefaultNumber(
            "RPC_CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS",
        ),
    },
};

export class ViemTokenUriResolver implements TokenUriResolverPort {
    private endpointSelector: WeightedEndpointSelector<TokenUriRpcEndpoint>;
    private metrics?: Metrics;
    private rpcObservability: RpcObservability;
    private rpcComponent: string;
    private retryPolicy: RpcRetryPolicy;

    constructor(private readonly config: TokenUriResolverConfig) {
        const endpoints = resolveTokenUriRpcEndpoints(config);
        this.retryPolicy = config.retryPolicy ?? DEFAULT_RETRY_POLICY;
        const resilience = config.resilience ?? DEFAULT_RESILIENCE;
        this.rpcComponent =
            config.component ?? INDEXER_RPC_OBSERVABILITY_COMPONENT.Metadata;
        const endpointIdPrefix =
            config.endpointIdPrefix ?? INDEXER_RPC_ENDPOINT_ID_PREFIX.Metadata;
        const createClient = config.createClient ?? createTokenUriViemClient;
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
        this.metrics = config.metrics;
        this.rpcObservability = new RpcObservability({
            workspace: RPC_OBSERVABILITY_WORKSPACE.Indexer,
            component: this.rpcComponent,
            protocol: RPC_PROTOCOL.Http,
            metrics: this.metrics,
            logComponent: INDEXER_RPC_LOG_COMPONENT.Metadata,
        });
        for (const endpoint of this.endpointSelector.snapshot()) {
            this.rpcObservability.recordConfiguredEndpoint(endpoint);
        }
    }

    async resolveTokenUri(
        contract: string,
        tokenId: string,
        standard: TokenStandard,
        blockNumber?: number,
    ): Promise<string | null> {
        const start = Date.now();
        try {
            const uri =
                standard === "erc721"
                    ? await this.readErc721Uri(contract, tokenId, blockNumber)
                    : await this.readErc1155Uri(contract, tokenId, blockNumber);
            this.metrics?.histogram(
                INDEXER_METADATA_RPC_METRIC.ResolveLatency,
                Date.now() - start,
                { standard, result: INDEXER_METADATA_RPC_RESULT.Ok },
            );
            return uri;
        } catch (error) {
            this.metrics?.increment(
                INDEXER_METADATA_RPC_METRIC.ResolveFailure,
                1,
                {
                    standard,
                },
            );
            this.metrics?.histogram(
                INDEXER_METADATA_RPC_METRIC.ResolveLatency,
                Date.now() - start,
                { standard, result: INDEXER_METADATA_RPC_RESULT.Error },
            );
            return null;
        }
    }

    private async readErc721Uri(
        contract: string,
        tokenId: string,
        blockNumber?: number,
    ): Promise<string> {
        return this.readWithEndpoint(INDEXER_RPC_METHOD.TokenUri, (client) =>
            client.readContract({
                address: contract as `0x${string}`,
                abi: ERC721_METADATA_ABI,
                functionName: INDEXER_RPC_METHOD.TokenUri,
                args: [BigInt(tokenId)],
                blockNumber:
                    blockNumber !== undefined ? BigInt(blockNumber) : undefined,
            }),
        );
    }

    private async readErc1155Uri(
        contract: string,
        tokenId: string,
        blockNumber?: number,
    ): Promise<string> {
        const uri = await this.readWithEndpoint(
            INDEXER_RPC_METHOD.Erc1155Uri,
            (client) =>
                client.readContract({
                    address: contract as `0x${string}`,
                    abi: ERC1155_METADATA_ABI,
                    functionName: INDEXER_RPC_METHOD.Erc1155Uri,
                    args: [BigInt(tokenId)],
                    blockNumber:
                        blockNumber !== undefined
                            ? BigInt(blockNumber)
                            : undefined,
                }),
        );
        return expandErc1155Uri(uri, tokenId);
    }

    private async readWithEndpoint<T>(
        method: string,
        read: (client: TokenUriRpcClient) => Promise<T>,
    ): Promise<T> {
        const call = this.rpcObservability.startCall(method);
        let lastEndpoint: TokenUriRpcEndpointSelection | null = null;
        try {
            const result = await executeWithRpcRetry({
                policy: this.retryPolicy,
                executeAttempt: (attempt) =>
                    this.readEndpointAttempt(
                        method,
                        read,
                        call,
                        attempt,
                        (endpoint) => {
                            lastEndpoint = endpoint;
                        },
                    ),
                onRetryScheduled: ({ attempt, nextAttempt, delayMs }) => {
                    if (lastEndpoint) {
                        this.rpcObservability.recordRetryScheduled({
                            method,
                            endpoint: lastEndpoint,
                            attempt,
                            nextAttempt,
                            delayMs,
                        });
                    }
                },
                sleep: this.config.sleep,
            });
            this.rpcObservability.recordCallSuccess(call, result.endpoint);
            return result.value;
        } catch (error) {
            this.rpcObservability.recordCallFailure(call, lastEndpoint, error);
            throw error;
        }
    }

    private async readEndpointAttempt<T>(
        method: string,
        read: (client: TokenUriRpcClient) => Promise<T>,
        call: RpcCallContext,
        attemptNumber: number,
        setLastEndpoint: (endpoint: TokenUriRpcEndpointSelection) => void,
    ): Promise<{ value: T; endpoint: TokenUriRpcEndpointSelection }> {
        const endpoint = this.endpointSelector.select();
        setLastEndpoint(endpoint);
        const attempt = this.rpcObservability.startEndpointAttempt(
            call,
            endpoint,
            attemptNumber,
        );
        try {
            const result = await endpoint.value.circuitBreaker.execute(() =>
                this.withRateLimit(endpoint, method, () =>
                    read(endpoint.value.client),
                ),
            );
            const updatedEndpoint =
                this.endpointSelector.recordSuccess(endpoint.id) ?? endpoint;
            setLastEndpoint(updatedEndpoint);
            this.rpcObservability.recordEndpointAttemptSuccess(
                attempt,
                updatedEndpoint,
            );
            return { value: result, endpoint: updatedEndpoint };
        } catch (error) {
            const updatedEndpoint =
                this.endpointSelector.recordFailure(endpoint.id) ?? endpoint;
            setLastEndpoint(updatedEndpoint);
            if (error instanceof CircuitOpenError) {
                this.rpcObservability.recordCircuitOpen(
                    method,
                    updatedEndpoint,
                    error,
                );
            }
            this.rpcObservability.recordEndpointAttemptFailure(
                attempt,
                updatedEndpoint,
                error,
            );
            this.metrics?.increment(
                INDEXER_METADATA_RPC_METRIC.EndpointFailure,
                1,
                {
                    endpoint: updatedEndpoint.id,
                    component: this.rpcComponent,
                },
            );
            throw error;
        }
    }

    private async withRateLimit<T>(
        endpoint: TokenUriRpcEndpointSelection,
        method: string,
        read: () => Promise<T>,
    ): Promise<T> {
        const waitedMs = await endpoint.value.rateLimiter.acquire();
        if (waitedMs > 0) {
            this.rpcObservability.recordRateLimitWait({
                method,
                endpoint,
                waitedMs,
            });
        }
        return read();
    }
}

function resolveTokenUriRpcEndpoints(
    config: TokenUriResolverConfig,
): RpcEndpointConfig[] {
    if (config.endpoints.length > 0) {
        return config.endpoints;
    }
    throw new Error("At least one metadata RPC endpoint URL is required");
}

function expandErc1155Uri(uri: string, tokenId: string): string {
    if (!uri.includes("{id}")) return uri;
    const hex = BigInt(tokenId).toString(16).padStart(64, "0");
    return uri.replace("{id}", hex);
}

function createTokenUriViemClient(url: string): TokenUriRpcClient {
    return createPublicClient({
        transport: http(url),
    });
}
