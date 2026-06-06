import dotenv from "dotenv";
import { resolveRuntimeEnvPath } from "@artgod/shared/utils";
import {
    assertOpenSeaIntegrationModeSatisfied,
    resolveOpenSeaIntegrationStatus,
    type OpenSeaIntegrationStatus,
} from "@artgod/shared/config/opensea-integration";
import {
    getSettingDefault,
    getSettingDefaultBoolean,
    getSettingDefaultNumber,
} from "@artgod/shared/config/generated-settings-defaults";
import {
    parseRpcEndpointConfigList,
    parseRpcWebSocketEndpointConfigList,
    type RpcEndpointConfig,
    type RpcWebSocketEndpointConfig,
} from "@artgod/shared/config/rpc-endpoints";
import {
    parseRpcEndpointResilienceConfig,
    parseRpcRetryPolicy,
} from "@artgod/shared/config/rpc-resilience";
import {
    parseBoolean,
    parseNumber,
    parsePositiveInteger,
    parseRequiredString,
} from "@artgod/shared/utils/env";
import type {
    RpcEndpointResilienceConfig,
    RpcRetryPolicy,
} from "@artgod/shared/evm/rpc-resilience";
import {
    parseIndexerApmConfig,
    parseIndexerMetricsConfig,
    type IndexerApmConfig,
    type IndexerMetricsConfig,
} from "./observability-env.js";

dotenv.config({ path: resolveRuntimeEnvPath(process.env, ".env") });

const DEFAULT_CHAIN_ID = getSettingDefaultNumber("CHAIN_ID");
const DEFAULT_NATS_URL = getSettingDefault("NATS_URL");
const DEFAULT_NATS_STREAM_PREFIX = getSettingDefault("NATS_STREAM_PREFIX");
const DEFAULT_REORG_DEPTH = getSettingDefaultNumber("REORG_DEPTH");
const DEFAULT_BACKFILL_BATCH_SIZE = getSettingDefaultNumber(
    "BACKFILL_BATCH_SIZE",
);
const DEFAULT_BACKFILL_WORKER_COUNT = getSettingDefaultNumber(
    "BACKFILL_WORKER_COUNT",
);
const DEFAULT_LOG_CHUNK_SIZE = getSettingDefaultNumber("LOG_CHUNK_SIZE");
const DEFAULT_CACHE_MAX_ENTRIES = getSettingDefaultNumber("CACHE_MAX_ENTRIES");
const DEFAULT_CACHE_TTL_MS = getSettingDefaultNumber("CACHE_TTL_MS");
const DEFAULT_BOOTSTRAP_SNAPSHOT_BATCH_SIZE = getSettingDefaultNumber(
    "BOOTSTRAP_SNAPSHOT_BATCH_SIZE",
);
const DEFAULT_BOOTSTRAP_METADATA_BATCH_SIZE = getSettingDefaultNumber(
    "BOOTSTRAP_METADATA_BATCH_SIZE",
);
const DEFAULT_BOOTSTRAP_METADATA_CONCURRENCY = getSettingDefaultNumber(
    "BOOTSTRAP_METADATA_CONCURRENCY",
);
const DEFAULT_BOOTSTRAP_METADATA_PROCESS_POLL_MS = getSettingDefaultNumber(
    "BOOTSTRAP_METADATA_PROCESS_POLL_MS",
);
const DEFAULT_BOOTSTRAP_METADATA_RETRY_MAX_ATTEMPTS = getSettingDefaultNumber(
    "BOOTSTRAP_METADATA_RETRY_MAX_ATTEMPTS",
);
const DEFAULT_BOOTSTRAP_METADATA_RETRY_BASE_DELAY_MS = getSettingDefaultNumber(
    "BOOTSTRAP_METADATA_RETRY_BASE_DELAY_MS",
);
const DEFAULT_BOOTSTRAP_METADATA_RETRY_MAX_DELAY_MS = getSettingDefaultNumber(
    "BOOTSTRAP_METADATA_RETRY_MAX_DELAY_MS",
);
const DEFAULT_METADATA_REFRESH_RANGE_CHUNK_SIZE = getSettingDefaultNumber(
    "METADATA_REFRESH_RANGE_CHUNK_SIZE",
);
const DEFAULT_OFFCHAIN_PERSIST_RAW_OBSERVATIONS = getSettingDefaultBoolean(
    "OFFCHAIN_PERSIST_RAW_OBSERVATIONS",
);

export type IndexerConfig = {
    dbPath: string;
    chainId: number;
    rpc: {
        endpoints: RpcEndpointConfig[];
        backfillEndpoints?: RpcEndpointConfig[];
        wsEndpoints?: RpcWebSocketEndpointConfig[];
        retryPolicy: RpcRetryPolicy;
        resilience: RpcEndpointResilienceConfig;
    };
    tokens: {
        wethAddress: string;
    };
    queue: {
        natsUrl: string;
        streamPrefix: string;
    };
    sync: {
        reorgDepth: number;
        backfillBatchSize: number;
        backfillWorkerCount: number;
        logChunkSize: number;
    };
    cache: {
        maxEntries: number;
        ttlMs: number;
    };
    bootstrap: {
        snapshotBatchSize: number;
        metadataBatchSize: number;
        metadataConcurrency: number;
        metadataProcessPollMs: number;
        metadataRetryPolicy: {
            maxAttempts: number;
            baseDelayMs: number;
            maxDelayMs: number;
        };
    };
    metadata: {
        refreshRangeChunkSize: number;
    };
    offchain: {
        persistRawObservations: boolean;
    };
    integrations: {
        opensea: OpenSeaIntegrationStatus;
    };
    seaport: {
        conduitController: string;
    };
    apm: IndexerApmConfig;
    metrics: IndexerMetricsConfig;
};

function parseAddress(value: string | undefined, name: string): string {
    if (!value) {
        throw new Error(`Missing ${name}`);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return value.toLowerCase();
}

export function loadConfig(
    env: Record<string, string | undefined> = process.env,
): IndexerConfig {
    const dbPath = parseRequiredString(env.ARTGOD_DB_PATH, "ARTGOD_DB_PATH");
    const chainId = parseNumber(env.CHAIN_ID, "CHAIN_ID", DEFAULT_CHAIN_ID);
    const rpcEndpoints = parseRpcEndpointConfigList(env.RPC_URL, "RPC_URL");
    const backfillEndpoints = env.RPC_BACKFILL_URL?.trim()
        ? parseRpcEndpointConfigList(env.RPC_BACKFILL_URL, "RPC_BACKFILL_URL")
        : undefined;
    const wsEndpoints = env.RPC_WS_URL?.trim()
        ? parseRpcWebSocketEndpointConfigList(env.RPC_WS_URL, "RPC_WS_URL")
        : undefined;
    const openseaIntegration = resolveOpenSeaIntegrationStatus(env);
    assertOpenSeaIntegrationModeSatisfied(openseaIntegration);

    return {
        dbPath,
        chainId,
        rpc: {
            endpoints: rpcEndpoints,
            backfillEndpoints,
            wsEndpoints,
            retryPolicy: parseRpcRetryPolicy(env),
            resilience: parseRpcEndpointResilienceConfig(env),
        },
        tokens: {
            wethAddress: parseAddress(env.WETH_ADDRESS, "WETH_ADDRESS"),
        },
        queue: {
            natsUrl: env.NATS_URL ?? DEFAULT_NATS_URL,
            streamPrefix: env.NATS_STREAM_PREFIX ?? DEFAULT_NATS_STREAM_PREFIX,
        },
        sync: {
            reorgDepth: parseNumber(
                env.REORG_DEPTH,
                "REORG_DEPTH",
                DEFAULT_REORG_DEPTH,
            ),
            backfillBatchSize: parseNumber(
                env.BACKFILL_BATCH_SIZE,
                "BACKFILL_BATCH_SIZE",
                DEFAULT_BACKFILL_BATCH_SIZE,
            ),
            backfillWorkerCount: parsePositiveInteger(
                env.BACKFILL_WORKER_COUNT,
                "BACKFILL_WORKER_COUNT",
                DEFAULT_BACKFILL_WORKER_COUNT,
            ),
            logChunkSize: parseNumber(
                env.LOG_CHUNK_SIZE,
                "LOG_CHUNK_SIZE",
                DEFAULT_LOG_CHUNK_SIZE,
            ),
        },
        cache: {
            maxEntries: parseNumber(
                env.CACHE_MAX_ENTRIES,
                "CACHE_MAX_ENTRIES",
                DEFAULT_CACHE_MAX_ENTRIES,
            ),
            ttlMs: parseNumber(
                env.CACHE_TTL_MS,
                "CACHE_TTL_MS",
                DEFAULT_CACHE_TTL_MS,
            ),
        },
        bootstrap: {
            snapshotBatchSize: parseNumber(
                env.BOOTSTRAP_SNAPSHOT_BATCH_SIZE,
                "BOOTSTRAP_SNAPSHOT_BATCH_SIZE",
                DEFAULT_BOOTSTRAP_SNAPSHOT_BATCH_SIZE,
            ),
            metadataBatchSize: parseNumber(
                env.BOOTSTRAP_METADATA_BATCH_SIZE,
                "BOOTSTRAP_METADATA_BATCH_SIZE",
                DEFAULT_BOOTSTRAP_METADATA_BATCH_SIZE,
            ),
            metadataConcurrency: parseNumber(
                env.BOOTSTRAP_METADATA_CONCURRENCY,
                "BOOTSTRAP_METADATA_CONCURRENCY",
                DEFAULT_BOOTSTRAP_METADATA_CONCURRENCY,
            ),
            metadataProcessPollMs: parseNumber(
                env.BOOTSTRAP_METADATA_PROCESS_POLL_MS,
                "BOOTSTRAP_METADATA_PROCESS_POLL_MS",
                DEFAULT_BOOTSTRAP_METADATA_PROCESS_POLL_MS,
            ),
            metadataRetryPolicy: {
                maxAttempts: parseNumber(
                    env.BOOTSTRAP_METADATA_RETRY_MAX_ATTEMPTS,
                    "BOOTSTRAP_METADATA_RETRY_MAX_ATTEMPTS",
                    DEFAULT_BOOTSTRAP_METADATA_RETRY_MAX_ATTEMPTS,
                ),
                baseDelayMs: parseNumber(
                    env.BOOTSTRAP_METADATA_RETRY_BASE_DELAY_MS,
                    "BOOTSTRAP_METADATA_RETRY_BASE_DELAY_MS",
                    DEFAULT_BOOTSTRAP_METADATA_RETRY_BASE_DELAY_MS,
                ),
                maxDelayMs: parseNumber(
                    env.BOOTSTRAP_METADATA_RETRY_MAX_DELAY_MS,
                    "BOOTSTRAP_METADATA_RETRY_MAX_DELAY_MS",
                    DEFAULT_BOOTSTRAP_METADATA_RETRY_MAX_DELAY_MS,
                ),
            },
        },
        metadata: {
            refreshRangeChunkSize: parseNumber(
                env.METADATA_REFRESH_RANGE_CHUNK_SIZE,
                "METADATA_REFRESH_RANGE_CHUNK_SIZE",
                DEFAULT_METADATA_REFRESH_RANGE_CHUNK_SIZE,
            ),
        },
        offchain: {
            persistRawObservations: parseBoolean(
                env.OFFCHAIN_PERSIST_RAW_OBSERVATIONS,
                "OFFCHAIN_PERSIST_RAW_OBSERVATIONS",
                DEFAULT_OFFCHAIN_PERSIST_RAW_OBSERVATIONS,
            ),
        },
        integrations: {
            opensea: openseaIntegration,
        },
        seaport: {
            conduitController: parseAddress(
                env.SEAPORT_CONDUIT_CONTROLLER,
                "SEAPORT_CONDUIT_CONTROLLER",
            ),
        },
        apm: parseIndexerApmConfig(env),
        metrics: parseIndexerMetricsConfig(env),
    };
}
