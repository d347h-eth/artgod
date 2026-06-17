import { describe, expect, it } from "vitest";
import {
    getSettingDefault,
    getSettingDefaultBoolean,
    getSettingDefaultNumber,
} from "@artgod/shared/config/generated-settings-defaults";
import {
    getDefaultRpcEndpointResilienceConfig,
    getDefaultRpcRetryPolicy,
} from "@artgod/shared/config/rpc-resilience";
import {
    getDefaultHttpFetchResilienceConfig,
    HTTP_FETCH_RESILIENCE_ENV_KEY,
} from "@artgod/shared/config/http-fetch-resilience";
import { COMMON_MEDIA_ENV_KEY } from "@artgod/shared/config/common-media";
import {
    RPC_BACKFILL_ENDPOINT_LIST_ENV_KEY,
    RPC_ENDPOINT_LIST_ENV_KEY,
    RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY,
} from "@artgod/shared/config/rpc-endpoints";
import { loadConfig } from "../src/config/index.js";

const REQUIRED_ENV = {
    ARTGOD_DB_PATH: "database/sqlite/test/db",
    [RPC_ENDPOINT_LIST_ENV_KEY]:
        '[{"url":"http://127.0.0.1:42721","weight":1}]',
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

    it("uses the manifest raw offchain observation default", () => {
        const config = loadConfig(REQUIRED_ENV);

        expect(config.offchain.persistRawObservations).toBe(
            getSettingDefaultBoolean("OFFCHAIN_PERSIST_RAW_OBSERVATIONS"),
        );
    });

    it("parses weighted RPC endpoint pools", () => {
        const config = loadConfig({
            ...REQUIRED_ENV,
            [RPC_ENDPOINT_LIST_ENV_KEY]:
                '[{"url":"https://rpc-a.example","weight":2},{"url":"https://rpc-b.example","weight":1}]',
            [RPC_BACKFILL_ENDPOINT_LIST_ENV_KEY]:
                '[{"url":"https://backfill-a.example","weight":3},{"url":"https://backfill-b.example","weight":1}]',
            [RPC_WEBSOCKET_ENDPOINT_LIST_ENV_KEY]:
                '[{"url":"wss://ws-a.example","weight":2},{"url":"ws://ws-b.example","weight":1}]',
        });

        expect(config.rpc.endpoints).toEqual([
            { url: "https://rpc-a.example", weight: 2 },
            { url: "https://rpc-b.example", weight: 1 },
        ]);
        expect(config.rpc.backfillEndpoints).toEqual([
            { url: "https://backfill-a.example", weight: 3 },
            { url: "https://backfill-b.example", weight: 1 },
        ]);
        expect(config.rpc.wsEndpoints).toEqual([
            { url: "wss://ws-a.example", weight: 2 },
            { url: "ws://ws-b.example", weight: 1 },
        ]);
    });

    it("uses manifest defaults for unprovided runtime tunables", () => {
        const config = loadConfig(REQUIRED_ENV);

        expect(config.chainId).toBe(getSettingDefaultNumber("CHAIN_ID"));
        expect(config.rpc.retryPolicy).toEqual(getDefaultRpcRetryPolicy());
        expect(config.rpc.resilience).toEqual(
            getDefaultRpcEndpointResilienceConfig(),
        );
        expect(config.queue).toEqual({
            natsUrl: getSettingDefault("NATS_URL"),
            streamPrefix: getSettingDefault("NATS_STREAM_PREFIX"),
        });
        expect(config.sync).toEqual({
            reorgDepth: getSettingDefaultNumber("REORG_DEPTH"),
            backfillBatchSize: getSettingDefaultNumber("BACKFILL_BATCH_SIZE"),
            backfillWorkerCount: getSettingDefaultNumber(
                "BACKFILL_WORKER_COUNT",
            ),
            logChunkSize: getSettingDefaultNumber("LOG_CHUNK_SIZE"),
        });
        expect(config.cache).toEqual({
            maxEntries: getSettingDefaultNumber("CACHE_MAX_ENTRIES"),
            ttlMs: getSettingDefaultNumber("CACHE_TTL_MS"),
        });
        expect(config.httpFetch).toEqual(getDefaultHttpFetchResilienceConfig());
        expect(config.bootstrap).toEqual({
            snapshotBatchSize: getSettingDefaultNumber(
                "BOOTSTRAP_SNAPSHOT_BATCH_SIZE",
            ),
            metadataBatchSize: getSettingDefaultNumber(
                "BOOTSTRAP_METADATA_BATCH_SIZE",
            ),
            metadataConcurrency: getSettingDefaultNumber(
                "BOOTSTRAP_METADATA_CONCURRENCY",
            ),
            metadataProcessPollMs: getSettingDefaultNumber(
                "BOOTSTRAP_METADATA_PROCESS_POLL_MS",
            ),
            schedulerPollMinMs: getSettingDefaultNumber(
                "BOOTSTRAP_SCHEDULER_POLL_MIN_MS",
            ),
            schedulerPollMaxMs: getSettingDefaultNumber(
                "BOOTSTRAP_SCHEDULER_POLL_MAX_MS",
            ),
            stepLeaseMs: getSettingDefaultNumber("BOOTSTRAP_STEP_LEASE_MS"),
            stepProgressStaleMs: getSettingDefaultNumber(
                "BOOTSTRAP_STEP_PROGRESS_STALE_MS",
            ),
            metadataRetryPolicy: {
                maxAttempts: getSettingDefaultNumber(
                    "BOOTSTRAP_METADATA_RETRY_MAX_ATTEMPTS",
                ),
                baseDelayMs: getSettingDefaultNumber(
                    "BOOTSTRAP_METADATA_RETRY_BASE_DELAY_MS",
                ),
                maxDelayMs: getSettingDefaultNumber(
                    "BOOTSTRAP_METADATA_RETRY_MAX_DELAY_MS",
                ),
            },
            imageCacheBatchSize: getSettingDefaultNumber(
                "BOOTSTRAP_IMAGE_CACHE_BATCH_SIZE",
            ),
            imageCacheConcurrency: getSettingDefaultNumber(
                "BOOTSTRAP_IMAGE_CACHE_CONCURRENCY",
            ),
            imageCacheMaxSourceBytes: getSettingDefaultNumber(
                "BOOTSTRAP_IMAGE_CACHE_MAX_SOURCE_BYTES",
            ),
        });
        expect(config.metadata.refreshRangeChunkSize).toBe(
            getSettingDefaultNumber("METADATA_REFRESH_RANGE_CHUNK_SIZE"),
        );
    });

    it("uses the manifest backfill worker count default", () => {
        const config = loadConfig(REQUIRED_ENV);

        expect(config.sync.backfillWorkerCount).toBe(
            getSettingDefaultNumber("BACKFILL_WORKER_COUNT"),
        );
    });

    it("parses configured backfill worker count", () => {
        const config = loadConfig({
            ...REQUIRED_ENV,
            BACKFILL_WORKER_COUNT: "4",
        });

        expect(config.sync.backfillWorkerCount).toBe(4);
    });

    it("rejects non-positive backfill worker counts", () => {
        expect(() =>
            loadConfig({
                ...REQUIRED_ENV,
                BACKFILL_WORKER_COUNT: "0",
            }),
        ).toThrow("Invalid BACKFILL_WORKER_COUNT");
    });

    it("parses IPFS gateway, media cache, and image cache bootstrap config", () => {
        const config = loadConfig({
            ...REQUIRED_ENV,
            [COMMON_MEDIA_ENV_KEY.IpfsGatewayOrigin]:
                "https://gateway.example/ipfs",
            [COMMON_MEDIA_ENV_KEY.MediaCacheDir]: "/tmp/artgod-token-media",
            BOOTSTRAP_IMAGE_CACHE_BATCH_SIZE: "25",
            BOOTSTRAP_IMAGE_CACHE_CONCURRENCY: "3",
            BOOTSTRAP_IMAGE_CACHE_MAX_SOURCE_BYTES: "123456",
            BOOTSTRAP_SCHEDULER_POLL_MIN_MS: "300",
            BOOTSTRAP_SCHEDULER_POLL_MAX_MS: "6000",
            BOOTSTRAP_STEP_LEASE_MS: "45000",
            BOOTSTRAP_STEP_PROGRESS_STALE_MS: "900000",
        });

        expect(config.ipfs.gatewayOrigin).toBe("https://gateway.example");
        expect(config.mediaCache.tokenImagesDir).toBe(
            "/tmp/artgod-token-media",
        );
        expect(config.bootstrap.imageCacheBatchSize).toBe(25);
        expect(config.bootstrap.imageCacheConcurrency).toBe(3);
        expect(config.bootstrap.imageCacheMaxSourceBytes).toBe(123456);
        expect(config.bootstrap.schedulerPollMinMs).toBe(300);
        expect(config.bootstrap.schedulerPollMaxMs).toBe(6000);
        expect(config.bootstrap.stepLeaseMs).toBe(45000);
        expect(config.bootstrap.stepProgressStaleMs).toBe(900000);
    });

    it("parses shared HTTP fetch resilience config", () => {
        const config = loadConfig({
            ...REQUIRED_ENV,
            [HTTP_FETCH_RESILIENCE_ENV_KEY.RequestTimeoutMs]: "1500",
            [HTTP_FETCH_RESILIENCE_ENV_KEY.RetryMaxAttempts]: "4",
            [HTTP_FETCH_RESILIENCE_ENV_KEY.RetryBaseDelayMs]: "125",
            [HTTP_FETCH_RESILIENCE_ENV_KEY.RetryMaxDelayMs]: "900",
        });

        expect(config.httpFetch).toEqual({
            requestTimeoutMs: 1500,
            retryPolicy: {
                maxAttempts: 4,
                baseDelayMs: 125,
                maxDelayMs: 900,
            },
        });
    });

    it("treats missing OpenSea API key as disabled in auto mode", () => {
        const config = loadConfig(REQUIRED_ENV);

        expect(config.integrations.opensea).toEqual({
            enabled: false,
            mode: "auto",
            reason: "OpenSea integration disabled because OPENSEA_API_KEY is not configured",
            missingKeys: ["OPENSEA_API_KEY"],
            requiredKeys: ["OPENSEA_API_KEY"],
        });
    });

    it("fails fast when OpenSea integration is required without an API key", () => {
        expect(() =>
            loadConfig({
                ...REQUIRED_ENV,
                OPENSEA_INTEGRATION_MODE: "enabled",
            }),
        ).toThrow(
            "OpenSea integration is enabled but OPENSEA_API_KEY is not configured",
        );
    });

    it("allows enabling raw offchain observation persistence", () => {
        const config = loadConfig({
            ...REQUIRED_ENV,
            OFFCHAIN_PERSIST_RAW_OBSERVATIONS: "true",
        });

        expect(config.offchain.persistRawObservations).toBe(true);
    });

    it("parses canonical indexer observability config", () => {
        const config = loadConfig({
            ...REQUIRED_ENV,
            INDEXER_METRICS_ENABLED: "true",
            INDEXER_METRICS_HOST: "127.0.0.1",
            INDEXER_METRICS_PORT_SYNC_WORKER: "42790",
            INDEXER_APM_ENABLED: "true",
            INDEXER_APM_SERVICE_NAMESPACE: "artgod.indexer-custom",
            INDEXER_APM_SPAN_PROFILES_ENABLED: "false",
            INDEXER_APM_TRACES_ENABLED: "false",
            OBSERVABILITY_OTLP_HTTP_URL: "http://tempo:42732/v1/traces",
            INDEXER_APM_PROFILES_ENABLED: "false",
            OBSERVABILITY_PYROSCOPE_URL: "http://pyroscope:42733",
        });

        expect(config.metrics.enabled).toBe(true);
        expect(config.metrics.host).toBe("127.0.0.1");
        expect(config.metrics.ports.syncWorker).toBe(42790);
        expect(config.apm).toMatchObject({
            enabled: true,
            serviceNamespace: "artgod.indexer-custom",
            spanProfiles: {
                enabled: false,
            },
            traces: {
                enabled: false,
                otlpHttpUrl: "http://tempo:42732/v1/traces",
            },
            profiles: {
                enabled: false,
                pyroscopeUrl: "http://pyroscope:42733",
            },
        });
    });
});
