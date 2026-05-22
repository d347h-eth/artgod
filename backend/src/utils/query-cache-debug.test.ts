import { describe, expect, it } from "vitest";
import {
    getCurrentQueryCacheDebugEvents,
    getCurrentQueryCacheDebugInfo,
    getCurrentQueryCacheDebugSummary,
    markCurrentQueryCacheBypass,
    markCurrentQueryCacheHit,
    QUERY_CACHE_DEBUG_STATUSES,
    runWithQueryCacheDebugContext,
} from "./query-cache-debug.js";

describe("query cache debug context", () => {
    it("keeps all cache events and exposes a mixed summary", () => {
        runWithQueryCacheDebugContext(() => {
            markCurrentQueryCacheHit({
                storedAt: 900,
                ttlMs: 60_000,
                now: 1_000,
            });
            markCurrentQueryCacheBypass();

            expect(getCurrentQueryCacheDebugEvents()).toEqual([
                {
                    status: QUERY_CACHE_DEBUG_STATUSES.Hit,
                    ageMs: 100,
                    ttlMs: 60_000,
                },
                {
                    status: QUERY_CACHE_DEBUG_STATUSES.Bypass,
                    ageMs: null,
                    ttlMs: null,
                },
            ]);
            expect(getCurrentQueryCacheDebugSummary()).toEqual({
                status: QUERY_CACHE_DEBUG_STATUSES.Mixed,
                ageMs: null,
                ttlMs: null,
                eventCount: 2,
            });
            expect(getCurrentQueryCacheDebugInfo()).toEqual({
                status: QUERY_CACHE_DEBUG_STATUSES.Mixed,
                ageMs: null,
                ttlMs: null,
            });
        });
    });
});
