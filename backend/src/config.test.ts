import { describe, expect, it } from "vitest";
import { loadBackendConfig } from "./config.js";
import { QUERY_CACHE_PROVIDERS } from "./ports/query-cache.js";

describe("loadBackendConfig", () => {
    it("normalizes canonical address config to lowercase", () => {
        const config = loadBackendConfig(createBaseEnv());

        expect(config.wethAddress).toBe(
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        );
    });

    it("defaults backend query cache to disabled", () => {
        const config = loadBackendConfig(createBaseEnv());

        expect(config.queryCache).toEqual({
            provider: QUERY_CACHE_PROVIDERS.Disabled,
            maxEntries: 500,
            collectionDetailDefaultTtlMs: 10000,
            tokenPreview: {
                maxEntries: 250,
                freshMs: 600000,
                staleMs: 1200000,
                warmupConcurrency: 3,
            },
        });
    });

    it("parses memory backend query cache config", () => {
        const config = loadBackendConfig({
            ...createBaseEnv(),
            BACKEND_QUERY_CACHE_PROVIDER: QUERY_CACHE_PROVIDERS.Memory,
            BACKEND_QUERY_CACHE_MAX_ENTRIES: "123",
            BACKEND_QUERY_CACHE_COLLECTION_DETAIL_DEFAULT_TTL_MS: "4321",
            BACKEND_QUERY_CACHE_TOKEN_PREVIEW_MAX_ENTRIES: "250",
            BACKEND_QUERY_CACHE_TOKEN_PREVIEW_FRESH_MS: "600000",
            BACKEND_QUERY_CACHE_TOKEN_PREVIEW_STALE_MS: "1200000",
            BACKEND_QUERY_CACHE_TOKEN_PREVIEW_WARMUP_CONCURRENCY: "4",
        });

        expect(config.queryCache).toEqual({
            provider: QUERY_CACHE_PROVIDERS.Memory,
            maxEntries: 123,
            collectionDetailDefaultTtlMs: 4321,
            tokenPreview: {
                maxEntries: 250,
                freshMs: 600000,
                staleMs: 1200000,
                warmupConcurrency: 4,
            },
        });
    });

    it("fails fast on invalid backend query cache provider", () => {
        expect(() =>
            loadBackendConfig({
                ...createBaseEnv(),
                BACKEND_QUERY_CACHE_PROVIDER: "redis",
            }),
        ).toThrow("Invalid BACKEND_QUERY_CACHE_PROVIDER");
    });

    it("fails fast when preview stale ttl is shorter than fresh ttl", () => {
        expect(() =>
            loadBackendConfig({
                ...createBaseEnv(),
                BACKEND_QUERY_CACHE_TOKEN_PREVIEW_FRESH_MS: "2000",
                BACKEND_QUERY_CACHE_TOKEN_PREVIEW_STALE_MS: "1000",
            }),
        ).toThrow(
            "BACKEND_QUERY_CACHE_TOKEN_PREVIEW_STALE_MS must be greater than or equal to BACKEND_QUERY_CACHE_TOKEN_PREVIEW_FRESH_MS",
        );
    });
});

function createBaseEnv(): Record<string, string> {
    return {
        BACKEND_HOST: "127.0.0.1",
        BACKEND_PORT: "3000",
        CHAIN_ID: "1",
        ARTGOD_DB_PATH: "database/sqlite/main/db",
        WETH_ADDRESS: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        NATS_URL: "nats://127.0.0.1:4222",
        NATS_STREAM_PREFIX: "artgod",
        BACKEND_ALLOWED_HOSTS: "127.0.0.1,localhost,::1",
        BACKEND_ALLOWED_ORIGINS:
            "http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:5173,http://localhost:5173",
        BACKEND_CSRF_COOKIE_SECURE: "false",
    };
}
