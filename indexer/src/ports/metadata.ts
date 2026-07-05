import type { TokenMetadata, TokenStandard } from "../domain/metadata.js";

export interface TokenUriResolverPort {
    resolveTokenUri(
        contract: string,
        tokenId: string,
        standard: TokenStandard,
        blockNumber?: number,
    ): Promise<string | null>;
}

export interface MetadataFetcherPort {
    fetchMetadata(
        uri: string,
        options?: {
            imageSourceField?: string | null;
        },
    ): Promise<TokenMetadata | null>;
}
