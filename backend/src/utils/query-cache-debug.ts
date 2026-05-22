import { AsyncLocalStorage } from "node:async_hooks";
import { QUERY_CACHE_DEBUG_STATUSES } from "@artgod/shared/config/query-cache-debug";

export {
    QUERY_CACHE_DEBUG_AGE_HEADER_NAME,
    QUERY_CACHE_DEBUG_HEADER_NAME,
    QUERY_CACHE_DEBUG_HEADER_NAMES,
    QUERY_CACHE_DEBUG_STATUSES,
    QUERY_CACHE_DEBUG_TTL_HEADER_NAME,
} from "@artgod/shared/config/query-cache-debug";

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

// Mark the current request as served from a query cache entry.
export function markCurrentQueryCacheHit(params: {
    storedAt: number;
    ttlMs: number;
    now?: number;
}): void {
    const { storedAt, ttlMs, now = Date.now() } = params;
    setCurrentQueryCacheDebugInfo({
        status: QUERY_CACHE_DEBUG_STATUSES.Hit,
        ageMs: Math.max(0, now - storedAt),
        ttlMs,
    });
}

// Mark the current request as requiring a cold cache fill.
export function markCurrentQueryCacheMiss(params: { ttlMs: number }): void {
    setCurrentQueryCacheDebugInfo({
        status: QUERY_CACHE_DEBUG_STATUSES.Miss,
        ageMs: 0,
        ttlMs: params.ttlMs,
    });
}

// Mark the current request as intentionally bypassing cache lookup.
export function markCurrentQueryCacheBypass(): void {
    setCurrentQueryCacheDebugInfo({
        status: QUERY_CACHE_DEBUG_STATUSES.Bypass,
    });
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
