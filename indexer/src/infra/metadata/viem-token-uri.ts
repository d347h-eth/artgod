import { createPublicClient, http } from "viem";
import {
    DEFAULT_RPC_ENDPOINT_WEIGHT,
    WeightedRpcEndpointSelector,
    type RpcEndpointConfig,
} from "@artgod/shared/config/rpc-endpoints";
import type { Metrics } from "@artgod/shared/observability/metrics";
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
    url?: string;
    endpoints?: RpcEndpointConfig[];
    metrics?: Metrics;
};

export class ViemTokenUriResolver implements TokenUriResolverPort {
    private endpointSelector: WeightedRpcEndpointSelector<
        ReturnType<typeof createPublicClient>
    >;
    private metrics?: Metrics;

    constructor(config: TokenUriResolverConfig) {
        const endpoints = resolveTokenUriRpcEndpoints(config);
        this.endpointSelector = new WeightedRpcEndpointSelector(
            endpoints.map((endpoint, index) => ({
                ...endpoint,
                id: `metadata-rpc-${index + 1}`,
                value: createPublicClient({
                    transport: http(endpoint.url),
                }),
            })),
        );
        this.metrics = config.metrics;
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
        return this.readWithEndpoint((client) =>
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
        const uri = await this.readWithEndpoint((client) =>
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
        read: (client: ReturnType<typeof createPublicClient>) => Promise<T>,
    ): Promise<T> {
        const endpoint = this.endpointSelector.select();
        try {
            const result = await read(endpoint.value);
            this.endpointSelector.recordSuccess(endpoint.id);
            return result;
        } catch (error) {
            this.endpointSelector.recordFailure(endpoint.id);
            this.metrics?.increment("metadata.resolve.endpoint_failure", 1, {
                endpoint: endpoint.id,
            });
            throw error;
        }
    }
}

function resolveTokenUriRpcEndpoints(
    config: TokenUriResolverConfig,
): RpcEndpointConfig[] {
    if (config.endpoints?.length) {
        return config.endpoints;
    }
    if (config.url?.trim()) {
        return [
            {
                url: config.url.trim(),
                weight: DEFAULT_RPC_ENDPOINT_WEIGHT,
            },
        ];
    }
    throw new Error("At least one metadata RPC endpoint URL is required");
}

function expandErc1155Uri(uri: string, tokenId: string): string {
    if (!uri.includes("{id}")) return uri;
    const hex = BigInt(tokenId).toString(16).padStart(64, "0");
    return uri.replace("{id}", hex);
}
