export type TokenImageCacheInput = {
    chainId: number;
    collectionId: number;
    tokenId: string;
    sourceImageUrl: string;
    requestedMaxDimension: number | null;
};

export type TokenImageCacheResult = {
    cacheKey: string;
    contentType: string;
    sourceBytes: number;
    cachedBytes: number;
    width: number | null;
    height: number | null;
    relativePath: string;
    publicPath: string;
};

export interface TokenImageCachePort {
    cacheTokenImage(input: TokenImageCacheInput): Promise<TokenImageCacheResult>;
    deleteCachedTokenImage(relativePath: string): Promise<void>;
}
