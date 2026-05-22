import { AsyncLocalStorage } from "node:async_hooks";
import { QUERY_CACHE_DEBUG_STATUSES } from "@artgod/shared/observability/http";

export {
    QUERY_CACHE_DEBUG_AGE_HEADER_NAME,
    QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME,
    QUERY_CACHE_DEBUG_HEADER_NAME,
    QUERY_CACHE_DEBUG_HEADER_NAMES,
    QUERY_CACHE_DEBUG_STATUSES,
    QUERY_CACHE_DEBUG_TTL_HEADER_NAME,
} from "@artgod/shared/observability/http";

export type QueryCacheDebugStatus =
    (typeof QUERY_CACHE_DEBUG_STATUSES)[keyof typeof QUERY_CACHE_DEBUG_STATUSES];

export type QueryCacheDebugEventStatus = Exclude<
    QueryCacheDebugStatus,
    typeof QUERY_CACHE_DEBUG_STATUSES.Mixed
>;

export type QueryCacheDebugEvent = {
    status: QueryCacheDebugEventStatus;
    ageMs: number | null;
    ttlMs: number | null;
};

export type QueryCacheDebugSummary = {
    status: QueryCacheDebugStatus;
    ageMs: number | null;
    ttlMs: number | null;
    eventCount: number;
};

type QueryCacheDebugContext = {
    events: QueryCacheDebugEvent[];
};

const queryCacheDebugStorage = new AsyncLocalStorage<QueryCacheDebugContext>();

export function runWithQueryCacheDebugContext<T>(fn: () => T): T {
    return queryCacheDebugStorage.run(
        {
            events: [],
        },
        fn,
    );
}

export function setCurrentQueryCacheDebugInfo(params: {
    status: QueryCacheDebugEventStatus;
    ageMs?: number | null;
    ttlMs?: number | null;
}): void {
    const { status, ageMs = null, ttlMs = null } = params;
    const store = queryCacheDebugStorage.getStore();
    if (!store) {
        return;
    }
    store.events.push({ status, ageMs, ttlMs });
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
    const summary = getCurrentQueryCacheDebugSummary();
    return summary
        ? {
              status: summary.status,
              ageMs: summary.ageMs,
              ttlMs: summary.ttlMs,
          }
        : {
              status: null,
              ageMs: null,
              ttlMs: null,
          };
}

export function setCurrentQueryCacheDebugStatus(
    status: QueryCacheDebugEventStatus,
): void {
    setCurrentQueryCacheDebugInfo({ status });
}

export function getCurrentQueryCacheDebugStatus(): QueryCacheDebugStatus | null {
    return getCurrentQueryCacheDebugInfo().status;
}

export function getCurrentQueryCacheDebugEvents(): QueryCacheDebugEvent[] {
    const store = queryCacheDebugStorage.getStore();
    return store ? [...store.events] : [];
}

export function getCurrentQueryCacheDebugSummary(): QueryCacheDebugSummary | null {
    return summarizeQueryCacheDebugEvents(getCurrentQueryCacheDebugEvents());
}

export function summarizeQueryCacheDebugEvents(
    events: QueryCacheDebugEvent[],
): QueryCacheDebugSummary | null {
    if (events.length === 0) {
        return null;
    }

    const statuses = new Set(events.map((event) => event.status));
    const status =
        statuses.size === 1
            ? events[0].status
            : QUERY_CACHE_DEBUG_STATUSES.Mixed;
    return {
        status,
        ageMs: summarizeNumericHeader(status, events, "ageMs"),
        ttlMs: summarizeNumericHeader(status, events, "ttlMs"),
        eventCount: events.length,
    };
}

function summarizeNumericHeader(
    status: QueryCacheDebugStatus,
    events: QueryCacheDebugEvent[],
    field: "ageMs" | "ttlMs",
): number | null {
    if (status === QUERY_CACHE_DEBUG_STATUSES.Mixed) {
        return null;
    }
    const values = events
        .map((event) => event[field])
        .filter((value): value is number => value !== null);
    if (values.length === 0) {
        return null;
    }
    if (field === "ttlMs") {
        return Math.min(...values);
    }
    return Math.max(...values);
}
