import { createPublicClient, http } from "viem";
import type { RpcEndpointConfig } from "@artgod/shared/config/rpc-endpoints";
import { WeightedEndpointSelector } from "@artgod/shared/config/weighted-endpoints";
import {
    getDefaultRpcEndpointResilienceConfig,
    getDefaultRpcRetryPolicy,
} from "@artgod/shared/config/rpc-resilience";
import { executeObservedRpcEndpointCall } from "@artgod/shared/evm/rpc-execution";
import {
    CircuitBreaker,
    type RpcEndpointResilienceConfig,
    type RpcRetryPolicy,
    TokenBucketRateLimiter,
    VIEM_TRANSPORT_RETRY_DISABLED,
} from "@artgod/shared/evm/rpc-resilience";
import type { Metrics } from "@artgod/shared/observability/metrics";
import {
    RPC_OBSERVABILITY_WORKSPACE,
    RPC_PROTOCOL,
    RpcObservability,
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

const DEFAULT_RETRY_POLICY = getDefaultRpcRetryPolicy();
const DEFAULT_RESILIENCE = getDefaultRpcEndpointResilienceConfig();

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
        const createClient =
            config.createClient ??
            ((url) =>
                createTokenUriViemClient(url, resilience.requestTimeoutMs));
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
        return executeObservedRpcEndpointCall({
            selector: this.endpointSelector,
            method,
            rpcObservability: this.rpcObservability,
            retryPolicy: this.retryPolicy,
            sleep: this.config.sleep,
            circuitBreaker: (endpoint) => endpoint.value.circuitBreaker,
            rateLimiter: (endpoint) => endpoint.value.rateLimiter,
            execute: (endpoint) => read(endpoint.value.client),
            onEndpointFailure: (endpoint) => {
                this.metrics?.increment(
                    INDEXER_METADATA_RPC_METRIC.EndpointFailure,
                    1,
                    {
                        endpoint: endpoint.id,
                        component: this.rpcComponent,
                    },
                );
            },
        });
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

function createTokenUriViemClient(
    url: string,
    requestTimeoutMs: number,
): TokenUriRpcClient {
    return createPublicClient({
        transport: http(url, {
            timeout: requestTimeoutMs,
            retryCount: VIEM_TRANSPORT_RETRY_DISABLED,
        }),
    });
}
