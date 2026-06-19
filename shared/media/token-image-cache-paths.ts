export const TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX = "/media/token-images";

// Returns true for root-relative URLs served by the backend token-image static route.
export function isTokenImageCachePublicPath(value: string): boolean {
    return (
        value === TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX ||
        value.startsWith(`${TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX}/`)
    );
}

// Builds the root-relative URL stored in read-model rows for cached images.
export function buildTokenImageCachePublicPath(relativePath: string): string {
    const normalized = relativePath
        .split(/[\\/]+/)
        .filter(Boolean)
        .map((part) => encodeURIComponent(part))
        .join("/");
    return `${TOKEN_IMAGE_CACHE_PUBLIC_PATH_PREFIX}/${normalized}`;
}
