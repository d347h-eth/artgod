import { describe, expect, it } from "vitest";
import {
    getSettingDefault,
    getSettingDefaultNumber,
} from "@artgod/shared/config/generated-settings-defaults";
import { loadOpenSeaConfig } from "../src/config/opensea.js";

describe("OpenSea config", () => {
    it("loads without fixture env vars", () => {
        const config = loadOpenSeaConfig({
            ARTGOD_DB_PATH: "database/sqlite/test/db",
            OPENSEA_API_KEY: "test-opensea-api-key",
        });

        expect(config.opensea.apiKey).toBe("test-opensea-api-key");
        expect(config.queue).toEqual({
            natsUrl: getSettingDefault("NATS_URL"),
            streamPrefix: getSettingDefault("NATS_STREAM_PREFIX"),
        });
        expect(config.opensea).toMatchObject({
            snapshotPageSize: getSettingDefaultNumber(
                "OPENSEA_SNAPSHOT_PAGE_SIZE",
            ),
            reconcileIntervalMs: getSettingDefaultNumber(
                "OPENSEA_RECONCILE_INTERVAL_MS",
            ),
            staleStartThresholdMs: getSettingDefaultNumber(
                "OPENSEA_STALE_START_THRESHOLD_MS",
            ),
            subscriptionPollMs: getSettingDefaultNumber(
                "OPENSEA_STREAM_SUBSCRIPTION_POLL_MS",
            ),
            retryPolicy: {
                maxAttempts: getSettingDefaultNumber(
                    "OPENSEA_HTTP_RETRY_MAX_ATTEMPTS",
                ),
                baseDelayMs: getSettingDefaultNumber(
                    "OPENSEA_HTTP_RETRY_BASE_DELAY_MS",
                ),
                maxDelayMs: getSettingDefaultNumber(
                    "OPENSEA_HTTP_RETRY_MAX_DELAY_MS",
                ),
                jitterRatio: getSettingDefaultNumber(
                    "OPENSEA_HTTP_RETRY_JITTER_RATIO",
                ),
            },
            rateLimiter: {
                getMax: getSettingDefaultNumber("OPENSEA_RATE_LIMIT_GET_MAX"),
                getRefillPerSecond: getSettingDefaultNumber(
                    "OPENSEA_RATE_LIMIT_GET_REFILL_PER_SECOND",
                ),
                postMax: getSettingDefaultNumber("OPENSEA_RATE_LIMIT_POST_MAX"),
                postRefillPerSecond: getSettingDefaultNumber(
                    "OPENSEA_RATE_LIMIT_POST_REFILL_PER_SECOND",
                ),
            },
        });
        expect("streamMode" in config.opensea).toBe(false);
    });

    it("parses canonical indexer observability names", () => {
        const config = loadOpenSeaConfig({
            ARTGOD_DB_PATH: "database/sqlite/test/db",
            OPENSEA_API_KEY: "test-opensea-api-key",
            INDEXER_APM_ENABLED: "true",
            OBSERVABILITY_OTLP_HTTP_URL: "http://tempo:42732/v1/traces",
            OBSERVABILITY_PYROSCOPE_URL: "http://pyroscope:42733",
            INDEXER_METRICS_ENABLED: "true",
            INDEXER_METRICS_PORT_OPENSEA_RECONCILE_WORKER: "42791",
        });

        expect(config.apm.enabled).toBe(true);
        expect(config.apm.traces.otlpHttpUrl).toBe(
            "http://tempo:42732/v1/traces",
        );
        expect(config.apm.profiles.pyroscopeUrl).toBe("http://pyroscope:42733");
        expect(config.metrics.enabled).toBe(true);
        expect(config.metrics.ports.reconcileWorker).toBe(42791);
    });

    it("fails when an OpenSea worker starts without enabled integration", () => {
        expect(() =>
            loadOpenSeaConfig({
                ARTGOD_DB_PATH: "database/sqlite/test/db",
            }),
        ).toThrow(
            "OpenSea integration disabled because OPENSEA_API_KEY is not configured",
        );
    });
});
