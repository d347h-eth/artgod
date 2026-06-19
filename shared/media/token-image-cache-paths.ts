export const TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX = "/media/token-images";

// Builds the root-relative URL stored in read-model rows for cached images.
export function buildTokenImageCachePublicPath(relativePath: string): string {
    const normalized = relativePath
        .split(/[\\/]+/)
        .filter(Boolean)
        .map((part) => encodeURIComponent(part))
        .join("/");
    return `${TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX}/${normalized}`;
}
