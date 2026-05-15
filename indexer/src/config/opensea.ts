import dotenv from "dotenv";
import { resolveRuntimeEnvPath } from "@artgod/shared/utils/runtime-env";
import { parseNumber, parseRequiredString } from "@artgod/shared/utils/env";
import {
    parseIndexerApmConfig,
    parseOpenSeaMetricsConfig,
    type IndexerApmConfig,
    type OpenSeaMetricsConfig,
} from "./observability-env.js";

export type OpenSeaRuntimeConfig = {
    dbPath: string;
    chainId: number;
    queue: {
        natsUrl: string;
        streamPrefix: string;
    };
    opensea: {
        apiKey: string;
        snapshotPageSize: number;
        reconcileIntervalMs: number;
        staleStartThresholdMs: number;
        subscriptionPollMs: number;
        retryPolicy: {
            maxAttempts: number;
            baseDelayMs: number;
            maxDelayMs: number;
            jitterRatio: number;
        };
        rateLimiter: {
            getMax: number;
            getRefillPerSecond: number;
            postMax: number;
            postRefillPerSecond: number;
        };
    };
    apm: IndexerApmConfig;
    metrics: OpenSeaRuntimeMetricsConfig;
};

type OpenSeaRuntimeMetricsConfig = Omit<OpenSeaMetricsConfig, "ports"> & {
    ports: {
        streamWorker: number;
        bootstrapWorker: number;
        reconcileWorker: number;
        reconcileSchedulerWorker: number;
    };
};

dotenv.config({ path: resolveRuntimeEnvPath(process.env, ".env") });

export function loadOpenSeaConfig(
    env: Record<string, string | undefined> = process.env,
): OpenSeaRuntimeConfig {
    const dbPath = parseRequiredString(env.ARTGOD_DB_PATH, "ARTGOD_DB_PATH");
    const chainId = parseNumber(env.CHAIN_ID, "CHAIN_ID", 1);
    const apiKey = parseRequiredString(env.OPENSEA_API_KEY, "OPENSEA_API_KEY");

    return {
        dbPath,
        chainId,
        queue: {
            natsUrl: env.NATS_URL ?? "nats://127.0.0.1:4222",
            streamPrefix: env.NATS_STREAM_PREFIX ?? "artgod",
        },
        opensea: {
            apiKey,
            snapshotPageSize: parseNumber(
                env.OPENSEA_SNAPSHOT_PAGE_SIZE,
                "OPENSEA_SNAPSHOT_PAGE_SIZE",
                100,
            ),
            reconcileIntervalMs: parseNumber(
                env.OPENSEA_RECONCILE_INTERVAL_MS,
                "OPENSEA_RECONCILE_INTERVAL_MS",
                15 * 60 * 1000,
            ),
            staleStartThresholdMs: parseNumber(
                env.OPENSEA_STALE_START_THRESHOLD_MS,
                "OPENSEA_STALE_START_THRESHOLD_MS",
                30 * 60 * 1000,
            ),
            subscriptionPollMs: parseNumber(
                env.OPENSEA_STREAM_SUBSCRIPTION_POLL_MS,
                "OPENSEA_STREAM_SUBSCRIPTION_POLL_MS",
                5_000,
            ),
            retryPolicy: {
                maxAttempts: parseNumber(
                    env.OPENSEA_HTTP_RETRY_MAX_ATTEMPTS,
                    "OPENSEA_HTTP_RETRY_MAX_ATTEMPTS",
                    3,
                ),
                baseDelayMs: parseNumber(
                    env.OPENSEA_HTTP_RETRY_BASE_DELAY_MS,
                    "OPENSEA_HTTP_RETRY_BASE_DELAY_MS",
                    500,
                ),
                maxDelayMs: parseNumber(
                    env.OPENSEA_HTTP_RETRY_MAX_DELAY_MS,
                    "OPENSEA_HTTP_RETRY_MAX_DELAY_MS",
                    10_000,
                ),
                jitterRatio: parseNumber(
                    env.OPENSEA_HTTP_RETRY_JITTER_RATIO,
                    "OPENSEA_HTTP_RETRY_JITTER_RATIO",
                    0.2,
                ),
            },
            rateLimiter: {
                getMax: parseNumber(
                    env.OPENSEA_RATE_LIMIT_GET_MAX,
                    "OPENSEA_RATE_LIMIT_GET_MAX",
                    4,
                ),
                getRefillPerSecond: parseNumber(
                    env.OPENSEA_RATE_LIMIT_GET_REFILL_PER_SECOND,
                    "OPENSEA_RATE_LIMIT_GET_REFILL_PER_SECOND",
                    1,
                ),
                postMax: parseNumber(
                    env.OPENSEA_RATE_LIMIT_POST_MAX,
                    "OPENSEA_RATE_LIMIT_POST_MAX",
                    2,
                ),
                postRefillPerSecond: parseNumber(
                    env.OPENSEA_RATE_LIMIT_POST_REFILL_PER_SECOND,
                    "OPENSEA_RATE_LIMIT_POST_REFILL_PER_SECOND",
                    0.5,
                ),
            },
        },
        apm: parseIndexerApmConfig(env),
        metrics: parseOpenSeaRuntimeMetricsConfig(env),
    };
}

function parseOpenSeaRuntimeMetricsConfig(
    env: Record<string, string | undefined>,
): OpenSeaRuntimeMetricsConfig {
    const metrics = parseOpenSeaMetricsConfig(env);
    return {
        enabled: metrics.enabled,
        host: metrics.host,
        ports: {
            streamWorker: metrics.ports.openseaStreamWorker,
            bootstrapWorker: metrics.ports.openseaBootstrapWorker,
            reconcileWorker: metrics.ports.openseaReconcileWorker,
            reconcileSchedulerWorker:
                metrics.ports.openseaReconcileSchedulerWorker,
        },
    };
}
