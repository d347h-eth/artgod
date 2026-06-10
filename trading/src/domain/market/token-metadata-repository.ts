// Token traits are consumed through a small port so bidder hot-refresh can stay persistence-agnostic.
export interface TokenMetadataTrait {
    type: string;
    value: string;
}

export interface TokenMetadataRepository {
    getTraits(
        collectionSlug: string,
        tokenId: string,
    ): Promise<TokenMetadataTrait[]>;
}
