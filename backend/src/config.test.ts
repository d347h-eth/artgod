import { describe, expect, it } from "vitest";
import { loadBackendConfig } from "./config.js";
import { QUERY_CACHE_PROVIDERS } from "./ports/query-cache.js";

describe("loadBackendConfig", () => {
    it("defaults backend query cache to disabled", () => {
        const config = loadBackendConfig(createBaseEnv());

        expect(config.queryCache).toEqual({
            provider: QUERY_CACHE_PROVIDERS.Disabled,
            maxEntries: 500,
            collectionDetailDefaultTtlMs: 10000,
        });
    });

    it("parses memory backend query cache config", () => {
        const config = loadBackendConfig({
            ...createBaseEnv(),
            BACKEND_QUERY_CACHE_PROVIDER: QUERY_CACHE_PROVIDERS.Memory,
            BACKEND_QUERY_CACHE_MAX_ENTRIES: "123",
            BACKEND_QUERY_CACHE_COLLECTION_DETAIL_DEFAULT_TTL_MS: "4321",
        });

        expect(config.queryCache).toEqual({
            provider: QUERY_CACHE_PROVIDERS.Memory,
            maxEntries: 123,
            collectionDetailDefaultTtlMs: 4321,
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
