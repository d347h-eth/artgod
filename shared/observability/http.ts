import { BLOCKSPACE_QUERY_PARAMS } from "../config/blockspace.js";
import { PAGINATION_QUERY_PARAMS } from "../config/pagination.js";
import { COLLECTION_MEDIA_QUERY_PARAMS } from "../extensions/index.js";
import {
    COLLECTION_DETAIL_QUERY_PARAMS,
    TRAIT_FILTER_QUERY_PARAMS,
} from "../types/browse.js";
import {
    ACTIVITY_EVENT_PREVIEW_QUERY_PARAMS,
    ACTIVITY_FEED_QUERY_PARAMS,
} from "../types/activity-feed.js";
import {
    COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS,
    COLLECTION_BIDDING_VIEW_QUERY_PARAMS,
} from "../types/trading.js";

// Correlates frontend SSR backend fetch logs with backend API response logs.
export const ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME =
    "X-ArtGod-SSR-Backend-Request-Id";

// Response headers used to expose query-cache state across HTTP boundaries.
export const QUERY_CACHE_DEBUG_HEADER_NAME = "X-ArtGod-Query-Cache";
export const QUERY_CACHE_DEBUG_AGE_HEADER_NAME = "X-ArtGod-Query-Cache-Age-Ms";
export const QUERY_CACHE_DEBUG_TTL_HEADER_NAME = "X-ArtGod-Query-Cache-Ttl-Ms";
export const QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME =
    "X-ArtGod-Query-Cache-Events";

// Ordered list of cache debug headers that can be forwarded by SSR routes.
export const QUERY_CACHE_DEBUG_HEADER_NAMES = [
    QUERY_CACHE_DEBUG_HEADER_NAME,
    QUERY_CACHE_DEBUG_AGE_HEADER_NAME,
    QUERY_CACHE_DEBUG_TTL_HEADER_NAME,
    QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME,
] as const;

// Serialized cache states surfaced in query-cache debug response headers.
export const QUERY_CACHE_DEBUG_STATUSES = {
    Hit: "hit",
    Miss: "miss",
    Bypass: "bypass",
    Mixed: "mixed",
} as const;

// Names generic backend API query parameters safe to expose as log metadata.
export const HTTP_OBSERVABILITY_GENERIC_QUERY_PARAMS = {
    Status: "status",
    Value: "value",
} as const;

export type HttpRequestTargetLogMetadata = {
    path: string | null;
    queryKeys: string[];
    queryParamCount: number;
    redactedQueryParamCount: number;
};

const HTTP_OBSERVABILITY_ALLOWED_QUERY_PARAM_NAMES = new Set<string>([
    ...Object.values(ACTIVITY_EVENT_PREVIEW_QUERY_PARAMS),
    ...Object.values(ACTIVITY_FEED_QUERY_PARAMS),
    ...Object.values(BLOCKSPACE_QUERY_PARAMS),
    ...Object.values(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS),
    ...Object.values(COLLECTION_BIDDING_VIEW_QUERY_PARAMS),
    ...Object.values(COLLECTION_DETAIL_QUERY_PARAMS),
    ...Object.values(COLLECTION_MEDIA_QUERY_PARAMS),
    ...Object.values(HTTP_OBSERVABILITY_GENERIC_QUERY_PARAMS),
    ...Object.values(PAGINATION_QUERY_PARAMS),
    ...Object.values(TRAIT_FILTER_QUERY_PARAMS),
]);

// Sanitizes request targets for logs by dropping origins, query values, and unknown query keys.
export function sanitizeHttpRequestTarget(
    url: string,
): HttpRequestTargetLogMetadata {
    try {
        const parsed = new URL(url, "http://artgod.local");
        const rawKeys = Array.from(parsed.searchParams.keys());
        const queryKeys = rawKeys
            .filter((key) => HTTP_OBSERVABILITY_ALLOWED_QUERY_PARAM_NAMES.has(key))
            .sort();
        return {
            path: parsed.pathname,
            queryKeys,
            queryParamCount: rawKeys.length,
            redactedQueryParamCount: rawKeys.length - queryKeys.length,
        };
    } catch {
        return {
            path: null,
            queryKeys: [],
            queryParamCount: 0,
            redactedQueryParamCount: 0,
        };
    }
}
