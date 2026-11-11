import type { TokenMetadata, TokenStandard } from "../domain/metadata.js";
import type { MetadataFetchOptions } from "../domain/metadata-pending.js";

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
        options?: MetadataFetchOptions,
    ): Promise<TokenMetadata | null>;
}
