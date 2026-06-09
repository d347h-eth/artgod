import type { ImageCacheMode } from "./token-image-cache.js";

// Queue name for durable token image cache refresh work.
export const TOKEN_IMAGE_CACHE_QUEUE_NAME = "token-image-cache";

// Job kinds accepted by the token image cache worker.
export const TOKEN_IMAGE_CACHE_JOB_KIND = {
    RefreshToken: "token-image-cache.refresh-token",
    RefreshCollection: "token-image-cache.refresh-collection",
} as const;

export type TokenImageCacheJobKind =
    (typeof TOKEN_IMAGE_CACHE_JOB_KIND)[keyof typeof TOKEN_IMAGE_CACHE_JOB_KIND];

// Reasons describe why a token image cache refresh job was enqueued.
export const TOKEN_IMAGE_CACHE_REFRESH_REASON = {
    MetadataRefresh: "metadata-refresh",
    PolicyRefresh: "policy-refresh",
    Bootstrap: "bootstrap",
} as const;

export type TokenImageCacheRefreshReason =
    (typeof TOKEN_IMAGE_CACHE_REFRESH_REASON)[keyof typeof TOKEN_IMAGE_CACHE_REFRESH_REASON];

const TOKEN_IMAGE_CACHE_JOB_ID_SCOPE = {
    TokenMetadataRefresh: "metadata",
    CollectionRefresh: "collection",
    CollectionRefreshStartCursor: "start",
} as const;

export type TokenImageCacheRefreshTokenPayload = {
    chainId: number;
    collectionId: number;
    tokenId: string;
    sourceImageUrl: string;
    requestedMaxDimension: number | null;
    imageCacheMode: ImageCacheMode;
    reason: TokenImageCacheRefreshReason;
    source: string | null;
};

export type TokenImageCacheRefreshCollectionPayload = {
    chainId: number;
    collectionId: number;
    cursorTokenId: string | null;
    requestedMaxDimension: number | null;
    imageCacheMode: ImageCacheMode;
    reason: TokenImageCacheRefreshReason;
};

// Builds stable job IDs for token-level image cache refresh work.
export function buildTokenImageCacheRefreshTokenJobId(input: {
    chainId: number;
    collectionId: number;
    tokenId: string;
    nowMs?: number;
}): string {
    return [
        TOKEN_IMAGE_CACHE_QUEUE_NAME,
        TOKEN_IMAGE_CACHE_JOB_ID_SCOPE.TokenMetadataRefresh,
        input.chainId,
        input.collectionId,
        input.tokenId,
        input.nowMs ?? Date.now(),
    ].join(":");
}

// Builds stable job IDs for collection-level image cache refresh work.
export function buildTokenImageCacheRefreshCollectionJobId(input: {
    chainId: number;
    collectionId: number;
    cursorTokenId?: string | null;
    nowMs?: number;
}): string {
    return [
        TOKEN_IMAGE_CACHE_QUEUE_NAME,
        TOKEN_IMAGE_CACHE_JOB_ID_SCOPE.CollectionRefresh,
        input.chainId,
        input.collectionId,
        input.cursorTokenId ??
            TOKEN_IMAGE_CACHE_JOB_ID_SCOPE.CollectionRefreshStartCursor,
        input.nowMs ?? Date.now(),
    ].join(":");
}
