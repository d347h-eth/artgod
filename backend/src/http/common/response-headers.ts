import type { FastifyInstance } from "fastify";
import type { BackendSecurityConfig } from "../../config.js";
import {
    getCurrentQueryCacheDebugInfo,
    QUERY_CACHE_DEBUG_AGE_HEADER_NAME,
    QUERY_CACHE_DEBUG_HEADER_NAME,
    QUERY_CACHE_DEBUG_TTL_HEADER_NAME,
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
        const queryCacheDebug = getCurrentQueryCacheDebugInfo();
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
        if (queryCacheDebug.status) {
            reply.header(QUERY_CACHE_DEBUG_HEADER_NAME, queryCacheDebug.status);
        }
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
        return payload;
    });
}
