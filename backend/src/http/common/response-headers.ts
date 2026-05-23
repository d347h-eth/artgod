import type { FastifyInstance } from "fastify";
import type { BackendSecurityConfig } from "../../config.js";
import {
    QUERY_CACHE_DEBUG_AGE_HEADER_NAME,
    QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME,
    QUERY_CACHE_DEBUG_HEADER_NAME,
    QUERY_CACHE_DEBUG_HEADER_NAMES,
    QUERY_CACHE_DEBUG_TTL_HEADER_NAME,
    getCurrentQueryCacheDebugSummary,
    runWithQueryCacheDebugContext,
} from "../../utils/query-cache-debug.js";
import {
    createApiOriginPolicy,
    normalizeOrigin,
} from "./origin-policy.js";

export function registerApiResponseHeaders(
    app: FastifyInstance,
    config: BackendSecurityConfig,
): void {
    const policy = createApiOriginPolicy(config);

    app.addHook("onRequest", (_request, _reply, done) => {
        runWithQueryCacheDebugContext(() => done());
    });

    app.addHook("onSend", async (request, reply, payload) => {
        const origin = normalizeOrigin(
            typeof request.headers.origin === "string"
                ? request.headers.origin
                : undefined,
        );
        const queryCacheDebug = getCurrentQueryCacheDebugSummary();
        if (origin && policy.allowedOrigins.has(origin)) {
            reply.header("Access-Control-Allow-Origin", origin);
            reply.header("Access-Control-Allow-Credentials", "true");
            reply.header("Vary", "Origin");
        }
        reply.header(
            "Access-Control-Allow-Methods",
            "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        );
        reply.header(
            "Access-Control-Allow-Headers",
            "Content-Type,X-ArtGod-CSRF",
        );
        if (queryCacheDebug) {
            reply.header(QUERY_CACHE_DEBUG_HEADER_NAME, queryCacheDebug.status);
            reply.header(
                QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME,
                String(queryCacheDebug.eventCount),
            );
            if (queryCacheDebug.ageMs !== null) {
                reply.header(
                    QUERY_CACHE_DEBUG_AGE_HEADER_NAME,
                    String(queryCacheDebug.ageMs),
                );
            }
            if (queryCacheDebug.ttlMs !== null) {
                reply.header(
                    QUERY_CACHE_DEBUG_TTL_HEADER_NAME,
                    String(queryCacheDebug.ttlMs),
                );
            }
        }
        return payload;
    });
}

export function extractQueryCacheDebugReplyHeaders(
    readHeader: (name: string) => number | string | string[] | undefined,
): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const headerName of QUERY_CACHE_DEBUG_HEADER_NAMES) {
        const value = readHeader(headerName);
        if (value === undefined) {
            continue;
        }
        headers[headerName] = Array.isArray(value)
            ? value.join(",")
            : String(value);
    }
    return headers;
}
