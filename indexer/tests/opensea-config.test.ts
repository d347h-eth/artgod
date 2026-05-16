import { describe, expect, it } from "vitest";
import { loadOpenSeaConfig } from "../src/config/opensea.js";

describe("OpenSea config", () => {
    it("loads without fixture env vars", () => {
        const config = loadOpenSeaConfig({
            ARTGOD_DB_PATH: "database/sqlite/test/db",
            OPENSEA_API_KEY: "test-opensea-api-key",
        });

        expect(config.opensea.apiKey).toBe("test-opensea-api-key");
        expect(config.opensea.snapshotPageSize).toBe(100);
        expect("streamMode" in config.opensea).toBe(false);
    });

    it("parses canonical indexer observability names", () => {
        const config = loadOpenSeaConfig({
            ARTGOD_DB_PATH: "database/sqlite/test/db",
            OPENSEA_API_KEY: "test-opensea-api-key",
            INDEXER_APM_ENABLED: "true",
            OBSERVABILITY_OTLP_HTTP_URL: "http://tempo:4318/v1/traces",
            OBSERVABILITY_PYROSCOPE_URL: "http://pyroscope:4040",
            INDEXER_METRICS_ENABLED: "true",
            INDEXER_METRICS_PORT_OPENSEA_RECONCILE_WORKER: "9573",
        });

        expect(config.apm.enabled).toBe(true);
        expect(config.apm.traces.otlpHttpUrl).toBe(
            "http://tempo:4318/v1/traces",
        );
        expect(config.apm.profiles.pyroscopeUrl).toBe(
            "http://pyroscope:4040",
        );
        expect(config.metrics.enabled).toBe(true);
        expect(config.metrics.ports.reconcileWorker).toBe(9573);
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
