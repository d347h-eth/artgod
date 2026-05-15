import { createPublicClient, http } from "viem";
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
    url: string;
    metrics?: Metrics;
};

export class ViemTokenUriResolver implements TokenUriResolverPort {
    private client: ReturnType<typeof createPublicClient>;
    private metrics?: Metrics;

    constructor(config: TokenUriResolverConfig) {
        this.client = createPublicClient({
            transport: http(config.url),
        });
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
        return this.client.readContract({
            address: contract as `0x${string}`,
            abi: ERC721_METADATA_ABI,
            functionName: "tokenURI",
            args: [BigInt(tokenId)],
            blockNumber:
                blockNumber !== undefined ? BigInt(blockNumber) : undefined,
        });
    }

    private async readErc1155Uri(
        contract: string,
        tokenId: string,
        blockNumber?: number,
    ): Promise<string> {
        const uri = await this.client.readContract({
            address: contract as `0x${string}`,
            abi: ERC1155_METADATA_ABI,
            functionName: "uri",
            args: [BigInt(tokenId)],
            blockNumber:
                blockNumber !== undefined ? BigInt(blockNumber) : undefined,
        });
        return expandErc1155Uri(uri, tokenId);
    }
}

function expandErc1155Uri(uri: string, tokenId: string): string {
    if (!uri.includes("{id}")) return uri;
    const hex = BigInt(tokenId).toString(16).padStart(64, "0");
    return uri.replace("{id}", hex);
}
