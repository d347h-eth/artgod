import { createPublicClient, http } from "viem";
import type { RpcEndpointConfig } from "@artgod/shared/config/rpc-endpoints";
import { WeightedEndpointSelector } from "@artgod/shared/config/weighted-endpoints";
import type { Metrics } from "@artgod/shared/observability/metrics";
import { RpcObservability } from "@artgod/shared/observability/rpc";
import type { TokenStandard } from "../../domain/metadata.js";
import type { TokenUriResolverPort } from "../../ports/metadata.js";

const ERC721_METADATA_ABI = [
    {
        type: "function",
        name: "tokenURI",
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "", type: "string" }],
    },
] as const;

const ERC1155_METADATA_ABI = [
    {
        type: "function",
        name: "uri",
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
        this.rpcComponent = config.component ?? "metadata-rpc";
        const endpointIdPrefix = config.endpointIdPrefix ?? "metadata-rpc";
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
            workspace: "indexer",
            component: this.rpcComponent,
            protocol: "http",
            metrics: this.metrics,
            logComponent: "IndexerMetadataRpc",
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
                "metadata.resolve.latency",
                Date.now() - start,
                { standard, result: "ok" },
            );
            return uri;
        } catch (error) {
            this.metrics?.increment("metadata.resolve.failure", 1, {
                standard,
            });
            this.metrics?.histogram(
                "metadata.resolve.latency",
                Date.now() - start,
                { standard, result: "error" },
            );
            return null;
        }
    }

    private async readErc721Uri(
        contract: string,
        tokenId: string,
        blockNumber?: number,
    ): Promise<string> {
        return this.readWithEndpoint("tokenURI", (client) =>
            client.readContract({
                address: contract as `0x${string}`,
                abi: ERC721_METADATA_ABI,
                functionName: "tokenURI",
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
        const uri = await this.readWithEndpoint("uri", (client) =>
            client.readContract({
                address: contract as `0x${string}`,
                abi: ERC1155_METADATA_ABI,
                functionName: "uri",
                args: [BigInt(tokenId)],
                blockNumber:
                    blockNumber !== undefined ? BigInt(blockNumber) : undefined,
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
            this.metrics?.increment("metadata.resolve.endpoint_failure", 1, {
                endpoint: updatedEndpoint.id,
                component: this.rpcComponent,
            });
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
