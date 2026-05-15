import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/index.js";

const REQUIRED_ENV = {
    ARTGOD_DB_PATH: "database/sqlite/test/db",
    RPC_URL: "http://127.0.0.1:8545",
    WETH_ADDRESS: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    SEAPORT_CONDUIT_CONTROLLER: "0x00000000f9490004c11cef243f5400493c00ad63",
};

describe("Indexer config", () => {
    it("normalizes canonical address config to lowercase", () => {
        const config = loadConfig({
            ...REQUIRED_ENV,
            SEAPORT_CONDUIT_CONTROLLER:
                "0x00000000F9490004C11cef243F5400493C00AD63",
        });

        expect(config.tokens.wethAddress).toBe(
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        );
        expect(config.seaport.conduitController).toBe(
            "0x00000000f9490004c11cef243f5400493c00ad63",
        );
    });

    it("persists raw offchain observations by default", () => {
        const config = loadConfig(REQUIRED_ENV);

        expect(config.offchain.persistRawObservations).toBe(true);
    });

    it("allows disabling raw offchain observation persistence", () => {
        const config = loadConfig({
            ...REQUIRED_ENV,
            OFFCHAIN_PERSIST_RAW_OBSERVATIONS: "false",
        });

        expect(config.offchain.persistRawObservations).toBe(false);
    });

    it("parses canonical indexer observability config", () => {
        const config = loadConfig({
            ...REQUIRED_ENV,
            INDEXER_METRICS_ENABLED: "true",
            INDEXER_METRICS_HOST: "127.0.0.1",
            INDEXER_METRICS_PORT_SYNC_WORKER: "9565",
            INDEXER_APM_ENABLED: "true",
            INDEXER_APM_SERVICE_NAMESPACE: "artgod.indexer-custom",
            INDEXER_APM_SPAN_PROFILES_ENABLED: "false",
            INDEXER_APM_TRACES_ENABLED: "false",
            OBSERVABILITY_OTLP_HTTP_URL: "http://tempo:4318/v1/traces",
            INDEXER_APM_PROFILES_ENABLED: "false",
            OBSERVABILITY_PYROSCOPE_URL: "http://pyroscope:4040",
        });

        expect(config.metrics.enabled).toBe(true);
        expect(config.metrics.host).toBe("127.0.0.1");
        expect(config.metrics.ports.syncWorker).toBe(9565);
        expect(config.apm).toMatchObject({
            enabled: true,
            serviceNamespace: "artgod.indexer-custom",
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

});
