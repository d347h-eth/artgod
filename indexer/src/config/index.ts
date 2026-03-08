import dotenv from "dotenv";
import { resolveRuntimeEnvPath } from "@artgod/shared/utils";
import {
    parseBoolean,
    parseNumber,
    parseRequiredString,
} from "@artgod/shared/utils/env";
import { defaultRetryPolicy } from "../domain/retry.js";

dotenv.config({ path: resolveRuntimeEnvPath(process.env, ".env") });

export type IndexerConfig = {
    dbPath: string;
    chainId: number;
    rpc: {
        primaryUrl: string;
        backfillUrl?: string;
        wsUrl?: string;
        retryPolicy: {
            maxAttempts: number;
            baseDelayMs: number;
            maxDelayMs: number;
        };
        resilience: {
            rateLimiter: {
                requestsPerSecond: number;
                burst: number;
            };
            circuitBreaker: {
                failureThreshold: number;
                openMs: number;
                halfOpenMaxRequests: number;
            };
        };
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
    seaport: {
        conduitController: string;
    };
    apm: {
        enabled: boolean;
        serviceNamespace: string;
        spanProfiles: {
            enabled: boolean;
        };
        traces: {
            enabled: boolean;
            otlpHttpUrl: string;
        };
        profiles: {
            enabled: boolean;
            pyroscopeUrl: string;
        };
    };
    metrics: {
        enabled: boolean;
        host: string;
        ports: {
            schedulerWorker: number;
            syncWorker: number;
            reorgWorker: number;
            domainWorker: number;
            offchainIngestWorker: number;
            openseaStreamWorker: number;
            openseaBootstrapWorker: number;
            openseaReconcileWorker: number;
            openseaReconcileSchedulerWorker: number;
            bootstrapWorker: number;
            collectionExtensionWorker: number;
            deadLetterWorker: number;
        };
    };
};

function parseAddress(value: string | undefined, name: string): string {
    if (!value) {
        throw new Error(`Missing ${name}`);
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return value;
}

export function loadConfig(
    env: Record<string, string | undefined> = process.env,
): IndexerConfig {
    const dbPath = parseRequiredString(env.ARTGOD_DB_PATH, "ARTGOD_DB_PATH");
    const chainId = parseNumber(env.CHAIN_ID, "CHAIN_ID", 1);
    const rpcUrl = env.RPC_URL;
    if (!rpcUrl) {
        throw new Error("Missing RPC_URL");
    }

    return {
        dbPath,
        chainId,
        rpc: {
            primaryUrl: rpcUrl,
            backfillUrl: env.RPC_BACKFILL_URL,
            wsUrl: env.RPC_WS_URL,
            retryPolicy: {
                maxAttempts: parseNumber(
                    env.RPC_RETRY_MAX_ATTEMPTS,
                    "RPC_RETRY_MAX_ATTEMPTS",
                    defaultRetryPolicy.maxAttempts,
                ),
                baseDelayMs: parseNumber(
                    env.RPC_RETRY_BASE_DELAY_MS,
                    "RPC_RETRY_BASE_DELAY_MS",
                    defaultRetryPolicy.baseDelayMs,
                ),
                maxDelayMs: parseNumber(
                    env.RPC_RETRY_MAX_DELAY_MS,
                    "RPC_RETRY_MAX_DELAY_MS",
                    defaultRetryPolicy.maxDelayMs,
                ),
            },
            resilience: {
                rateLimiter: {
                    requestsPerSecond: parseNumber(
                        env.RPC_RATE_LIMIT_REQUESTS_PER_SECOND,
                        "RPC_RATE_LIMIT_REQUESTS_PER_SECOND",
                        20,
                    ),
                    burst: parseNumber(
                        env.RPC_RATE_LIMIT_BURST,
                        "RPC_RATE_LIMIT_BURST",
                        40,
                    ),
                },
                circuitBreaker: {
                    failureThreshold: parseNumber(
                        env.RPC_CIRCUIT_BREAKER_FAILURE_THRESHOLD,
                        "RPC_CIRCUIT_BREAKER_FAILURE_THRESHOLD",
                        5,
                    ),
                    openMs: parseNumber(
                        env.RPC_CIRCUIT_BREAKER_OPEN_MS,
                        "RPC_CIRCUIT_BREAKER_OPEN_MS",
                        30_000,
                    ),
                    halfOpenMaxRequests: parseNumber(
                        env.RPC_CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS,
                        "RPC_CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS",
                        2,
                    ),
                },
            },
        },
        tokens: {
            wethAddress: parseAddress(env.WETH_ADDRESS, "WETH_ADDRESS"),
        },
        queue: {
            natsUrl: env.NATS_URL ?? "nats://127.0.0.1:4222",
            streamPrefix: env.NATS_STREAM_PREFIX ?? "artgod",
        },
        sync: {
            reorgDepth: parseNumber(env.REORG_DEPTH, "REORG_DEPTH", 20),
            backfillBatchSize: parseNumber(
                env.BACKFILL_BATCH_SIZE,
                "BACKFILL_BATCH_SIZE",
                50,
            ),
            logChunkSize: parseNumber(
                env.LOG_CHUNK_SIZE,
                "LOG_CHUNK_SIZE",
                2000,
            ),
        },
        cache: {
            maxEntries: parseNumber(
                env.CACHE_MAX_ENTRIES,
                "CACHE_MAX_ENTRIES",
                5000,
            ),
            ttlMs: parseNumber(env.CACHE_TTL_MS, "CACHE_TTL_MS", 30_000),
        },
        bootstrap: {
            snapshotBatchSize: parseNumber(
                env.BOOTSTRAP_SNAPSHOT_BATCH_SIZE,
                "BOOTSTRAP_SNAPSHOT_BATCH_SIZE",
                200,
            ),
            metadataBatchSize: parseNumber(
                env.BOOTSTRAP_METADATA_BATCH_SIZE,
                "BOOTSTRAP_METADATA_BATCH_SIZE",
                200,
            ),
            metadataConcurrency: parseNumber(
                env.BOOTSTRAP_METADATA_CONCURRENCY,
                "BOOTSTRAP_METADATA_CONCURRENCY",
                8,
            ),
            metadataProcessPollMs: parseNumber(
                env.BOOTSTRAP_METADATA_PROCESS_POLL_MS,
                "BOOTSTRAP_METADATA_PROCESS_POLL_MS",
                5_000,
            ),
            metadataRetryPolicy: {
                maxAttempts: parseNumber(
                    env.BOOTSTRAP_METADATA_RETRY_MAX_ATTEMPTS,
                    "BOOTSTRAP_METADATA_RETRY_MAX_ATTEMPTS",
                    defaultRetryPolicy.maxAttempts,
                ),
                baseDelayMs: parseNumber(
                    env.BOOTSTRAP_METADATA_RETRY_BASE_DELAY_MS,
                    "BOOTSTRAP_METADATA_RETRY_BASE_DELAY_MS",
                    defaultRetryPolicy.baseDelayMs,
                ),
                maxDelayMs: parseNumber(
                    env.BOOTSTRAP_METADATA_RETRY_MAX_DELAY_MS,
                    "BOOTSTRAP_METADATA_RETRY_MAX_DELAY_MS",
                    defaultRetryPolicy.maxDelayMs,
                ),
            },
        },
        metadata: {
            refreshRangeChunkSize: parseNumber(
                env.METADATA_REFRESH_RANGE_CHUNK_SIZE,
                "METADATA_REFRESH_RANGE_CHUNK_SIZE",
                200,
            ),
        },
        seaport: {
            conduitController: parseAddress(
                env.SEAPORT_CONDUIT_CONTROLLER,
                "SEAPORT_CONDUIT_CONTROLLER",
            ),
        },
        apm: {
            enabled: parseBoolean(env.APM_ENABLED, "APM_ENABLED", false),
            serviceNamespace: env.APM_SERVICE_NAMESPACE ?? "artgod.indexer",
            spanProfiles: {
                enabled: parseBoolean(
                    env.APM_SPAN_PROFILES_ENABLED,
                    "APM_SPAN_PROFILES_ENABLED",
                    true,
                ),
            },
            traces: {
                enabled: parseBoolean(
                    env.APM_TRACES_ENABLED,
                    "APM_TRACES_ENABLED",
                    true,
                ),
                otlpHttpUrl:
                    env.APM_OTLP_HTTP_URL ?? "http://127.0.0.1:4318/v1/traces",
            },
            profiles: {
                enabled: parseBoolean(
                    env.APM_PROFILES_ENABLED,
                    "APM_PROFILES_ENABLED",
                    true,
                ),
                pyroscopeUrl: env.APM_PYROSCOPE_URL ?? "http://127.0.0.1:4040",
            },
        },
        metrics: {
            enabled: parseBoolean(
                env.METRICS_ENABLED,
                "METRICS_ENABLED",
                false,
            ),
            host: env.METRICS_HOST ?? "0.0.0.0",
            ports: {
                schedulerWorker: parseNumber(
                    env.METRICS_PORT_SCHEDULER_WORKER,
                    "METRICS_PORT_SCHEDULER_WORKER",
                    9464,
                ),
                syncWorker: parseNumber(
                    env.METRICS_PORT_SYNC_WORKER,
                    "METRICS_PORT_SYNC_WORKER",
                    9465,
                ),
                reorgWorker: parseNumber(
                    env.METRICS_PORT_REORG_WORKER,
                    "METRICS_PORT_REORG_WORKER",
                    9466,
                ),
                domainWorker: parseNumber(
                    env.METRICS_PORT_DOMAIN_WORKER,
                    "METRICS_PORT_DOMAIN_WORKER",
                    9467,
                ),
                offchainIngestWorker: parseNumber(
                    env.METRICS_PORT_OFFCHAIN_INGEST_WORKER,
                    "METRICS_PORT_OFFCHAIN_INGEST_WORKER",
                    9468,
                ),
                openseaStreamWorker: parseNumber(
                    env.METRICS_PORT_OPENSEA_STREAM_WORKER,
                    "METRICS_PORT_OPENSEA_STREAM_WORKER",
                    9469,
                ),
                openseaBootstrapWorker: parseNumber(
                    env.METRICS_PORT_OPENSEA_BOOTSTRAP_WORKER,
                    "METRICS_PORT_OPENSEA_BOOTSTRAP_WORKER",
                    9472,
                ),
                openseaReconcileWorker: parseNumber(
                    env.METRICS_PORT_OPENSEA_RECONCILE_WORKER,
                    "METRICS_PORT_OPENSEA_RECONCILE_WORKER",
                    9473,
                ),
                openseaReconcileSchedulerWorker: parseNumber(
                    env.METRICS_PORT_OPENSEA_RECONCILE_SCHEDULER_WORKER,
                    "METRICS_PORT_OPENSEA_RECONCILE_SCHEDULER_WORKER",
                    9474,
                ),
                bootstrapWorker: parseNumber(
                    env.METRICS_PORT_BOOTSTRAP_WORKER,
                    "METRICS_PORT_BOOTSTRAP_WORKER",
                    9470,
                ),
                collectionExtensionWorker: parseNumber(
                    env.METRICS_PORT_COLLECTION_EXTENSION_WORKER,
                    "METRICS_PORT_COLLECTION_EXTENSION_WORKER",
                    9475,
                ),
                deadLetterWorker: parseNumber(
                    env.METRICS_PORT_DEAD_LETTER_WORKER,
                    "METRICS_PORT_DEAD_LETTER_WORKER",
                    9471,
                ),
            },
        },
    };
}
