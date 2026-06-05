import { createPublicClient, http } from "viem";
import type { RpcEndpointConfig } from "@artgod/shared/config/rpc-endpoints";
import { WeightedEndpointSelector } from "@artgod/shared/config/weighted-endpoints";
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
};

export class ViemTokenUriResolver implements TokenUriResolverPort {
    private endpointSelector: WeightedEndpointSelector<
        ReturnType<typeof createPublicClient>
    >;
    private metrics?: Metrics;
    private rpcObservability: RpcObservability;
    private rpcComponent: string;

    constructor(config: TokenUriResolverConfig) {
        const endpoints = resolveTokenUriRpcEndpoints(config);
        this.rpcComponent =
            config.component ?? INDEXER_RPC_OBSERVABILITY_COMPONENT.Metadata;
        const endpointIdPrefix =
            config.endpointIdPrefix ?? INDEXER_RPC_ENDPOINT_ID_PREFIX.Metadata;
        this.endpointSelector = new WeightedEndpointSelector(
            endpoints.map((endpoint, index) => ({
                ...endpoint,
                id: `${endpointIdPrefix}-${index + 1}`,
                value: createPublicClient({
                    transport: http(endpoint.url),
                }),
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
        read: (client: ReturnType<typeof createPublicClient>) => Promise<T>,
    ): Promise<T> {
        const call = this.rpcObservability.startCall(method);
        const endpoint = this.endpointSelector.select();
        const attempt = this.rpcObservability.startEndpointAttempt(
            call,
            endpoint,
            1,
        );
        try {
            const result = await read(endpoint.value);
            const updatedEndpoint =
                this.endpointSelector.recordSuccess(endpoint.id) ?? endpoint;
            this.rpcObservability.recordEndpointAttemptSuccess(
                attempt,
                updatedEndpoint,
            );
            this.rpcObservability.recordCallSuccess(call, updatedEndpoint);
            return result;
        } catch (error) {
            const updatedEndpoint =
                this.endpointSelector.recordFailure(endpoint.id) ?? endpoint;
            this.rpcObservability.recordEndpointAttemptFailure(
                attempt,
                updatedEndpoint,
                error,
            );
            this.rpcObservability.recordCallFailure(call, updatedEndpoint, error);
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
