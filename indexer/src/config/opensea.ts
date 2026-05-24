import dotenv from "dotenv";
import { resolveRuntimeEnvPath } from "@artgod/shared/utils/runtime-env";
import { parseNumber, parseRequiredString } from "@artgod/shared/utils/env";
import { requireOpenSeaIntegrationEnabled } from "@artgod/shared/config/opensea-integration";
import {
    getSettingDefault,
    getSettingDefaultNumber,
} from "@artgod/shared/config/generated-settings-defaults";
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

const DEFAULT_CHAIN_ID = getSettingDefaultNumber("CHAIN_ID");
const DEFAULT_NATS_URL = getSettingDefault("NATS_URL");
const DEFAULT_NATS_STREAM_PREFIX = getSettingDefault("NATS_STREAM_PREFIX");
const DEFAULT_OPENSEA_SNAPSHOT_PAGE_SIZE = getSettingDefaultNumber(
    "OPENSEA_SNAPSHOT_PAGE_SIZE",
);
const DEFAULT_OPENSEA_RECONCILE_INTERVAL_MS = getSettingDefaultNumber(
    "OPENSEA_RECONCILE_INTERVAL_MS",
);
const DEFAULT_OPENSEA_STALE_START_THRESHOLD_MS = getSettingDefaultNumber(
    "OPENSEA_STALE_START_THRESHOLD_MS",
);
const DEFAULT_OPENSEA_STREAM_SUBSCRIPTION_POLL_MS = getSettingDefaultNumber(
    "OPENSEA_STREAM_SUBSCRIPTION_POLL_MS",
);
const DEFAULT_OPENSEA_HTTP_RETRY_MAX_ATTEMPTS = getSettingDefaultNumber(
    "OPENSEA_HTTP_RETRY_MAX_ATTEMPTS",
);
const DEFAULT_OPENSEA_HTTP_RETRY_BASE_DELAY_MS = getSettingDefaultNumber(
    "OPENSEA_HTTP_RETRY_BASE_DELAY_MS",
);
const DEFAULT_OPENSEA_HTTP_RETRY_MAX_DELAY_MS = getSettingDefaultNumber(
    "OPENSEA_HTTP_RETRY_MAX_DELAY_MS",
);
const DEFAULT_OPENSEA_HTTP_RETRY_JITTER_RATIO = getSettingDefaultNumber(
    "OPENSEA_HTTP_RETRY_JITTER_RATIO",
);
const DEFAULT_OPENSEA_RATE_LIMIT_GET_MAX = getSettingDefaultNumber(
    "OPENSEA_RATE_LIMIT_GET_MAX",
);
const DEFAULT_OPENSEA_RATE_LIMIT_GET_REFILL_PER_SECOND =
    getSettingDefaultNumber("OPENSEA_RATE_LIMIT_GET_REFILL_PER_SECOND");
const DEFAULT_OPENSEA_RATE_LIMIT_POST_MAX = getSettingDefaultNumber(
    "OPENSEA_RATE_LIMIT_POST_MAX",
);
const DEFAULT_OPENSEA_RATE_LIMIT_POST_REFILL_PER_SECOND =
    getSettingDefaultNumber("OPENSEA_RATE_LIMIT_POST_REFILL_PER_SECOND");

export function loadOpenSeaConfig(
    env: Record<string, string | undefined> = process.env,
): OpenSeaRuntimeConfig {
    const dbPath = parseRequiredString(env.ARTGOD_DB_PATH, "ARTGOD_DB_PATH");
    const chainId = parseNumber(env.CHAIN_ID, "CHAIN_ID", DEFAULT_CHAIN_ID);
    requireOpenSeaIntegrationEnabled(env);
    const apiKey = parseRequiredString(env.OPENSEA_API_KEY, "OPENSEA_API_KEY");

    return {
        dbPath,
        chainId,
        queue: {
            natsUrl: env.NATS_URL ?? DEFAULT_NATS_URL,
            streamPrefix: env.NATS_STREAM_PREFIX ?? DEFAULT_NATS_STREAM_PREFIX,
        },
        opensea: {
            apiKey,
            snapshotPageSize: parseNumber(
                env.OPENSEA_SNAPSHOT_PAGE_SIZE,
                "OPENSEA_SNAPSHOT_PAGE_SIZE",
                DEFAULT_OPENSEA_SNAPSHOT_PAGE_SIZE,
            ),
            reconcileIntervalMs: parseNumber(
                env.OPENSEA_RECONCILE_INTERVAL_MS,
                "OPENSEA_RECONCILE_INTERVAL_MS",
                DEFAULT_OPENSEA_RECONCILE_INTERVAL_MS,
            ),
            staleStartThresholdMs: parseNumber(
                env.OPENSEA_STALE_START_THRESHOLD_MS,
                "OPENSEA_STALE_START_THRESHOLD_MS",
                DEFAULT_OPENSEA_STALE_START_THRESHOLD_MS,
            ),
            subscriptionPollMs: parseNumber(
                env.OPENSEA_STREAM_SUBSCRIPTION_POLL_MS,
                "OPENSEA_STREAM_SUBSCRIPTION_POLL_MS",
                DEFAULT_OPENSEA_STREAM_SUBSCRIPTION_POLL_MS,
            ),
            retryPolicy: {
                maxAttempts: parseNumber(
                    env.OPENSEA_HTTP_RETRY_MAX_ATTEMPTS,
                    "OPENSEA_HTTP_RETRY_MAX_ATTEMPTS",
                    DEFAULT_OPENSEA_HTTP_RETRY_MAX_ATTEMPTS,
                ),
                baseDelayMs: parseNumber(
                    env.OPENSEA_HTTP_RETRY_BASE_DELAY_MS,
                    "OPENSEA_HTTP_RETRY_BASE_DELAY_MS",
                    DEFAULT_OPENSEA_HTTP_RETRY_BASE_DELAY_MS,
                ),
                maxDelayMs: parseNumber(
                    env.OPENSEA_HTTP_RETRY_MAX_DELAY_MS,
                    "OPENSEA_HTTP_RETRY_MAX_DELAY_MS",
                    DEFAULT_OPENSEA_HTTP_RETRY_MAX_DELAY_MS,
                ),
                jitterRatio: parseNumber(
                    env.OPENSEA_HTTP_RETRY_JITTER_RATIO,
                    "OPENSEA_HTTP_RETRY_JITTER_RATIO",
                    DEFAULT_OPENSEA_HTTP_RETRY_JITTER_RATIO,
                ),
            },
            rateLimiter: {
                getMax: parseNumber(
                    env.OPENSEA_RATE_LIMIT_GET_MAX,
                    "OPENSEA_RATE_LIMIT_GET_MAX",
                    DEFAULT_OPENSEA_RATE_LIMIT_GET_MAX,
                ),
                getRefillPerSecond: parseNumber(
                    env.OPENSEA_RATE_LIMIT_GET_REFILL_PER_SECOND,
                    "OPENSEA_RATE_LIMIT_GET_REFILL_PER_SECOND",
                    DEFAULT_OPENSEA_RATE_LIMIT_GET_REFILL_PER_SECOND,
                ),
                postMax: parseNumber(
                    env.OPENSEA_RATE_LIMIT_POST_MAX,
                    "OPENSEA_RATE_LIMIT_POST_MAX",
                    DEFAULT_OPENSEA_RATE_LIMIT_POST_MAX,
                ),
                postRefillPerSecond: parseNumber(
                    env.OPENSEA_RATE_LIMIT_POST_REFILL_PER_SECOND,
                    "OPENSEA_RATE_LIMIT_POST_REFILL_PER_SECOND",
                    DEFAULT_OPENSEA_RATE_LIMIT_POST_REFILL_PER_SECOND,
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
