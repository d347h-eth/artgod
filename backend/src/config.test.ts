import { describe, expect, it } from "vitest";
import { loadBackendConfig } from "./config.js";
import { QUERY_CACHE_PROVIDERS } from "./ports/query-cache.js";

describe("loadBackendConfig", () => {
    it("normalizes canonical address config to lowercase", () => {
        const config = loadBackendConfig(createBaseEnv());

        expect(config.rpcUrl).toBe("http://127.0.0.1:8545");
        expect(config.wethAddress).toBe(
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        );
    });

    it("defaults backend query cache to disabled", () => {
        const config = loadBackendConfig(createBaseEnv());

        expect(config.queryCache).toEqual({
            provider: QUERY_CACHE_PROVIDERS.Disabled,
            publicCollection: {
                detailRefreshMs: 30000,
                previewWarmRefreshMs: 600000,
            },
            tokenPreview: {
                maxEntries: 250,
                freshMs: 600000,
                staleMs: 1200000,
                warmupConcurrency: 3,
            },
        });
    });

    it("uses the shared backfill batch size for backend-triggered sync jobs", () => {
        const config = loadBackendConfig({
            ...createBaseEnv(),
            BACKFILL_BATCH_SIZE: "25",
        });

        expect(config.sync).toEqual({
            backfillBatchSize: 25,
        });
    });

    it("defaults backend observability to disabled runtime endpoints", () => {
        const config = loadBackendConfig(createBaseEnv());

        expect(config.metrics).toEqual({
            enabled: false,
            host: "0.0.0.0",
            port: 9480,
        });
        expect(config.apm).toEqual({
            enabled: false,
            serviceNamespace: "artgod.backend",
            spanProfiles: {
                enabled: true,
            },
            traces: {
                enabled: true,
                otlpHttpUrl: "http://127.0.0.1:4318/v1/traces",
            },
            profiles: {
                enabled: true,
                pyroscopeUrl: "http://127.0.0.1:4040",
            },
        });
    });

    it("parses backend observability overrides", () => {
        const config = loadBackendConfig({
            ...createBaseEnv(),
            BACKEND_METRICS_ENABLED: "true",
            BACKEND_METRICS_HOST: "127.0.0.1",
            BACKEND_METRICS_PORT: "9481",
            BACKEND_APM_ENABLED: "true",
            BACKEND_APM_SERVICE_NAMESPACE: "artgod.backend-public",
            BACKEND_APM_SPAN_PROFILES_ENABLED: "false",
            BACKEND_APM_TRACES_ENABLED: "false",
            BACKEND_APM_OTLP_HTTP_URL: "http://tempo:4318/v1/traces",
            BACKEND_APM_PROFILES_ENABLED: "false",
            BACKEND_APM_PYROSCOPE_URL: "http://pyroscope:4040",
        });

        expect(config.metrics).toEqual({
            enabled: true,
            host: "127.0.0.1",
            port: 9481,
        });
        expect(config.apm).toEqual({
            enabled: true,
            serviceNamespace: "artgod.backend-public",
            spanProfiles: {
                enabled: false,
            },
            traces: {
                enabled: false,
                otlpHttpUrl: "http://tempo:4318/v1/traces",
            },
            profiles: {
                enabled: false,
                pyroscopeUrl: "http://pyroscope:4040",
            },
        });
    });

    it("uses composition-level observability endpoints when backend-specific endpoints are omitted", () => {
        const config = loadBackendConfig({
            ...createBaseEnv(),
            OBSERVABILITY_OTLP_HTTP_URL: "http://tempo:4318/v1/traces",
            OBSERVABILITY_PYROSCOPE_URL: "http://pyroscope:4040",
        });

        expect(config.apm.traces.otlpHttpUrl).toBe(
            "http://tempo:4318/v1/traces",
        );
        expect(config.apm.profiles.pyroscopeUrl).toBe(
            "http://pyroscope:4040",
        );
    });

    it("defaults OpenSea integration to disabled when no API key is configured", () => {
        const config = loadBackendConfig(createBaseEnv());

        expect(config.integrations.opensea).toEqual({
            enabled: false,
            mode: "auto",
            reason: "OpenSea integration disabled because OPENSEA_API_KEY is not configured",
            missingKeys: ["OPENSEA_API_KEY"],
            requiredKeys: ["OPENSEA_API_KEY"],
        });
    });

    it("enables OpenSea integration when auto mode has an API key", () => {
        const config = loadBackendConfig({
            ...createBaseEnv(),
            OPENSEA_API_KEY: "test-opensea-key",
        });

        expect(config.integrations.opensea).toEqual({
            enabled: true,
            mode: "auto",
            reason: null,
            missingKeys: [],
            requiredKeys: ["OPENSEA_API_KEY"],
        });
    });

    it("fails fast when OpenSea integration is required without an API key", () => {
        expect(() =>
            loadBackendConfig({
                ...createBaseEnv(),
                OPENSEA_INTEGRATION_MODE: "enabled",
            }),
        ).toThrow(
            "OpenSea integration is enabled but OPENSEA_API_KEY is not configured",
        );
    });

    it("parses memory backend query cache config", () => {
        const config = loadBackendConfig({
            ...createBaseEnv(),
            BACKEND_QUERY_CACHE_PROVIDER: QUERY_CACHE_PROVIDERS.Memory,
            BACKEND_PUBLIC_COLLECTION_CACHE_REFRESH_MS: "4321",
            BACKEND_PUBLIC_COLLECTION_PREVIEW_WARM_REFRESH_MS: "6543",
            BACKEND_QUERY_CACHE_TOKEN_PREVIEW_MAX_ENTRIES: "250",
            BACKEND_QUERY_CACHE_TOKEN_PREVIEW_FRESH_MS: "600000",
            BACKEND_QUERY_CACHE_TOKEN_PREVIEW_STALE_MS: "1200000",
            BACKEND_QUERY_CACHE_TOKEN_PREVIEW_WARMUP_CONCURRENCY: "4",
        });

        expect(config.queryCache).toEqual({
            provider: QUERY_CACHE_PROVIDERS.Memory,
            publicCollection: {
                detailRefreshMs: 4321,
                previewWarmRefreshMs: 6543,
            },
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

    it("accepts local desktop WebView origins in backend origin config", () => {
        const config = loadBackendConfig({
            ...createBaseEnv(),
            BACKEND_ALLOWED_ORIGINS:
                "http://127.0.0.1:3000,tauri://localhost,http://tauri.localhost",
        });

        expect(config.security.allowedOrigins).toEqual([
            "http://127.0.0.1:3000",
            "tauri://localhost",
            "http://tauri.localhost",
        ]);
    });

    it("rejects placeholder custom protocol origins", () => {
        expect(() =>
            loadBackendConfig({
                ...createBaseEnv(),
                BACKEND_ALLOWED_ORIGINS: "customprotocol://localhost",
            }),
        ).toThrow("Invalid BACKEND_ALLOWED_ORIGINS entry");
    });
});

function createBaseEnv(): Record<string, string> {
    return {
        BACKEND_HOST: "127.0.0.1",
        BACKEND_PORT: "3000",
        CHAIN_ID: "1",
        ARTGOD_DB_PATH: "database/sqlite/main/db",
        RPC_URL: "http://127.0.0.1:8545",
        WETH_ADDRESS: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        NATS_URL: "nats://127.0.0.1:4222",
        NATS_STREAM_PREFIX: "artgod",
        BACKEND_ALLOWED_HOSTS: "127.0.0.1,localhost,::1",
        BACKEND_ALLOWED_ORIGINS:
            "http://127.0.0.1:3000,http://localhost:3000,http://127.0.0.1:5173,http://localhost:5173",
        BACKEND_CSRF_COOKIE_SECURE: "false",
    };
}
