import {
    BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION,
    BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION,
    BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION,
} from "../config/bootstrap.js";
export {
    buildTokenImageCachePublicPath,
    TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX,
} from "./token-image-cache-paths.js";

// Image cache modes define how local token-card media is populated and refreshed.
export const IMAGE_CACHE_MODE = {
    Off: "off",
    CacheOnce: "cache_once",
    RefreshOnMetadata: "refresh_on_metadata",
} as const;

export type ImageCacheMode =
    (typeof IMAGE_CACHE_MODE)[keyof typeof IMAGE_CACHE_MODE];

export type ImageCachePolicyConfig = {
    imageCacheMode: ImageCacheMode;
    maxDimension: number | null;
};

// Returns the generic image-cache policy used when no extension overrides it.
export function defaultImageCachePolicyConfig(): ImageCachePolicyConfig {
    return {
        imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
        maxDimension: BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION,
    };
}

// Normalizes persisted/user-provided image cache policy values.
export function normalizeImageCachePolicyConfig(
    input: ImageCachePolicyConfig | null | undefined,
): ImageCachePolicyConfig {
    if (!input) {
        return defaultImageCachePolicyConfig();
    }

    return {
        imageCacheMode: normalizeImageCacheMode(input.imageCacheMode),
        maxDimension: normalizeImageCacheMaxDimension(input.maxDimension),
    };
}

// Returns true when the policy asks the cache worker to produce local media.
export function isImageCachePolicyActive(
    config: ImageCachePolicyConfig,
): boolean {
    return config.imageCacheMode !== IMAGE_CACHE_MODE.Off;
}

// Returns true when metadata refresh should enqueue a token image recache.
export function shouldRefreshImageCacheOnMetadata(
    config: ImageCachePolicyConfig,
): boolean {
    return config.imageCacheMode === IMAGE_CACHE_MODE.RefreshOnMetadata;
}

function normalizeImageCacheMode(value: unknown): ImageCacheMode {
    if (
        value === IMAGE_CACHE_MODE.Off ||
        value === IMAGE_CACHE_MODE.CacheOnce ||
        value === IMAGE_CACHE_MODE.RefreshOnMetadata
    ) {
        return value;
    }
    return IMAGE_CACHE_MODE.CacheOnce;
}

function normalizeImageCacheMaxDimension(value: unknown): number | null {
    if (value === null) {
        return null;
    }
    if (!Number.isInteger(value)) {
        return BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION;
    }
    const parsed = Number(value);
    if (
        parsed < BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION ||
        parsed > BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION
    ) {
        return BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION;
    }
    return parsed;
}
