// Token metadata is consumed through a small port so bidder hot-refresh can stay persistence-agnostic.
export interface TokenMetadataRepository {
    getMetadata(collectionSlug: string, tokenId: string): Promise<string | null>;
}
