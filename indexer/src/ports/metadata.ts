import type { TokenMetadata, TokenStandard } from "../domain/metadata.js";

export interface TokenUriResolverPort {
    resolveTokenUri(
        contract: string,
        tokenId: string,
        standard: TokenStandard,
    ): Promise<string | null>;
}

export interface MetadataFetcherPort {
    fetchMetadata(uri: string): Promise<TokenMetadata | null>;
}
