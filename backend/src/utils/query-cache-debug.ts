import { AsyncLocalStorage } from "node:async_hooks";

export const QUERY_CACHE_DEBUG_HEADER_NAME = "X-ArtGod-Query-Cache";
export const QUERY_CACHE_DEBUG_AGE_HEADER_NAME = "X-ArtGod-Query-Cache-Age-Ms";
export const QUERY_CACHE_DEBUG_TTL_HEADER_NAME = "X-ArtGod-Query-Cache-Ttl-Ms";

export const QUERY_CACHE_DEBUG_STATUSES = {
    Hit: "hit",
    Miss: "miss",
    Bypass: "bypass",
} as const;

export type QueryCacheDebugStatus =
    (typeof QUERY_CACHE_DEBUG_STATUSES)[keyof typeof QUERY_CACHE_DEBUG_STATUSES];

type QueryCacheDebugContext = {
    status: QueryCacheDebugStatus | null;
    ageMs: number | null;
    ttlMs: number | null;
};

const queryCacheDebugStorage = new AsyncLocalStorage<QueryCacheDebugContext>();

export function runWithQueryCacheDebugContext<T>(fn: () => T): T {
    return queryCacheDebugStorage.run(
        {
            status: null,
            ageMs: null,
            ttlMs: null,
        },
        fn,
    );
}

export function setCurrentQueryCacheDebugInfo(params: {
    status: QueryCacheDebugStatus;
    ageMs?: number | null;
    ttlMs?: number | null;
}): void {
    const { status, ageMs = null, ttlMs = null } = params;
    const store = queryCacheDebugStorage.getStore();
    if (!store) {
        return;
    }
    store.status = status;
    store.ageMs = ageMs;
    store.ttlMs = ttlMs;
}

export function getCurrentQueryCacheDebugInfo(): {
    status: QueryCacheDebugStatus | null;
    ageMs: number | null;
    ttlMs: number | null;
} {
    const store = queryCacheDebugStorage.getStore();
    return {
        status: store?.status ?? null,
        ageMs: store?.ageMs ?? null,
        ttlMs: store?.ttlMs ?? null,
    };
}

export function setCurrentQueryCacheDebugStatus(
    status: QueryCacheDebugStatus,
): void {
    setCurrentQueryCacheDebugInfo({ status });
}

export function getCurrentQueryCacheDebugStatus(): QueryCacheDebugStatus | null {
    return getCurrentQueryCacheDebugInfo().status;
}
