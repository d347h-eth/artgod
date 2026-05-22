// Response headers used to expose query-cache state across backend/frontend boundaries.
export const QUERY_CACHE_DEBUG_HEADER_NAME = "X-ArtGod-Query-Cache";
export const QUERY_CACHE_DEBUG_AGE_HEADER_NAME = "X-ArtGod-Query-Cache-Age-Ms";
export const QUERY_CACHE_DEBUG_TTL_HEADER_NAME = "X-ArtGod-Query-Cache-Ttl-Ms";

// Ordered list of cache debug headers that can be forwarded by SSR frontend routes.
export const QUERY_CACHE_DEBUG_HEADER_NAMES = [
    QUERY_CACHE_DEBUG_HEADER_NAME,
    QUERY_CACHE_DEBUG_AGE_HEADER_NAME,
    QUERY_CACHE_DEBUG_TTL_HEADER_NAME,
] as const;

// Serialized cache states surfaced in query-cache debug response headers.
export const QUERY_CACHE_DEBUG_STATUSES = {
    Hit: "hit",
    Miss: "miss",
    Bypass: "bypass",
} as const;

