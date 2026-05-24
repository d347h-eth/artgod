import { parseBoolean, parseNumber } from "@artgod/shared/utils/env";

export const DEFAULT_INDEXER_APM_SERVICE_NAMESPACE = "artgod.indexer";
export const DEFAULT_OBSERVABILITY_OTLP_HTTP_URL =
    "http://127.0.0.1:42732/v1/traces";
export const DEFAULT_OBSERVABILITY_PYROSCOPE_URL = "http://127.0.0.1:42733";

// Canonical APM config shared by all indexer runtimes.
export type IndexerApmConfig = {
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

// Canonical metrics config for the full indexer worker set.
export type IndexerMetricsConfig = {
    enabled: boolean;
    host: string;
    ports: IndexerMetricsPortsConfig;
};

// Prometheus ports for every indexer runtime.
export type IndexerMetricsPortsConfig = {
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

// Canonical metrics config used by OpenSea-only runtimes.
export type OpenSeaMetricsConfig = {
    enabled: boolean;
    host: string;
    ports: Pick<
        IndexerMetricsPortsConfig,
        | "openseaStreamWorker"
        | "openseaBootstrapWorker"
        | "openseaReconcileWorker"
        | "openseaReconcileSchedulerWorker"
    >;
};

// Parses the canonical indexer APM env group.
export function parseIndexerApmConfig(
    env: Record<string, string | undefined>,
): IndexerApmConfig {
    return {
        enabled: parseBoolean(
            env.INDEXER_APM_ENABLED,
            "INDEXER_APM_ENABLED",
            false,
        ),
        serviceNamespace: readOptionalString(
            env,
            ["INDEXER_APM_SERVICE_NAMESPACE"],
            DEFAULT_INDEXER_APM_SERVICE_NAMESPACE,
        ),
        spanProfiles: {
            enabled: parseBoolean(
                env.INDEXER_APM_SPAN_PROFILES_ENABLED,
                "INDEXER_APM_SPAN_PROFILES_ENABLED",
                true,
            ),
        },
        traces: {
            enabled: parseBoolean(
                env.INDEXER_APM_TRACES_ENABLED,
                "INDEXER_APM_TRACES_ENABLED",
                true,
            ),
            otlpHttpUrl: readOptionalString(
                env,
                ["INDEXER_APM_OTLP_HTTP_URL", "OBSERVABILITY_OTLP_HTTP_URL"],
                DEFAULT_OBSERVABILITY_OTLP_HTTP_URL,
            ),
        },
        profiles: {
            enabled: parseBoolean(
                env.INDEXER_APM_PROFILES_ENABLED,
                "INDEXER_APM_PROFILES_ENABLED",
                true,
            ),
            pyroscopeUrl: readOptionalString(
                env,
                [
                    "INDEXER_APM_PYROSCOPE_URL",
                    "OBSERVABILITY_PYROSCOPE_URL",
                ],
                DEFAULT_OBSERVABILITY_PYROSCOPE_URL,
            ),
        },
    };
}

// Parses all canonical indexer metrics ports.
export function parseIndexerMetricsConfig(
    env: Record<string, string | undefined>,
): IndexerMetricsConfig {
    return {
        ...parseMetricsBaseConfig(env),
        ports: {
            schedulerWorker: parseNumber(
                env.INDEXER_METRICS_PORT_SCHEDULER_WORKER,
                "INDEXER_METRICS_PORT_SCHEDULER_WORKER",
                42741,
            ),
            syncWorker: parseNumber(
                env.INDEXER_METRICS_PORT_SYNC_WORKER,
                "INDEXER_METRICS_PORT_SYNC_WORKER",
                42742,
            ),
            reorgWorker: parseNumber(
                env.INDEXER_METRICS_PORT_REORG_WORKER,
                "INDEXER_METRICS_PORT_REORG_WORKER",
                42743,
            ),
            domainWorker: parseNumber(
                env.INDEXER_METRICS_PORT_DOMAIN_WORKER,
                "INDEXER_METRICS_PORT_DOMAIN_WORKER",
                42744,
            ),
            offchainIngestWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OFFCHAIN_INGEST_WORKER,
                "INDEXER_METRICS_PORT_OFFCHAIN_INGEST_WORKER",
                42745,
            ),
            openseaStreamWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_STREAM_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_STREAM_WORKER",
                42746,
            ),
            openseaBootstrapWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_BOOTSTRAP_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_BOOTSTRAP_WORKER",
                42749,
            ),
            openseaReconcileWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_RECONCILE_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_RECONCILE_WORKER",
                42750,
            ),
            openseaReconcileSchedulerWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_RECONCILE_SCHEDULER_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_RECONCILE_SCHEDULER_WORKER",
                42751,
            ),
            bootstrapWorker: parseNumber(
                env.INDEXER_METRICS_PORT_BOOTSTRAP_WORKER,
                "INDEXER_METRICS_PORT_BOOTSTRAP_WORKER",
                42747,
            ),
            collectionExtensionWorker: parseNumber(
                env.INDEXER_METRICS_PORT_COLLECTION_EXTENSION_WORKER,
                "INDEXER_METRICS_PORT_COLLECTION_EXTENSION_WORKER",
                42752,
            ),
            deadLetterWorker: parseNumber(
                env.INDEXER_METRICS_PORT_DEAD_LETTER_WORKER,
                "INDEXER_METRICS_PORT_DEAD_LETTER_WORKER",
                42748,
            ),
        },
    };
}

// Parses the canonical OpenSea worker metrics ports.
export function parseOpenSeaMetricsConfig(
    env: Record<string, string | undefined>,
): OpenSeaMetricsConfig {
    return {
        ...parseMetricsBaseConfig(env),
        ports: {
            openseaStreamWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_STREAM_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_STREAM_WORKER",
                42746,
            ),
            openseaBootstrapWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_BOOTSTRAP_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_BOOTSTRAP_WORKER",
                42749,
            ),
            openseaReconcileWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_RECONCILE_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_RECONCILE_WORKER",
                42750,
            ),
            openseaReconcileSchedulerWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_RECONCILE_SCHEDULER_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_RECONCILE_SCHEDULER_WORKER",
                42751,
            ),
        },
    };
}

// Resolves optional string values across workspace-specific and composition-level names.
function readOptionalString(
    env: Record<string, string | undefined>,
    names: string[],
    defaultValue: string,
): string {
    for (const name of names) {
        const value = env[name]?.trim();
        if (value) return value;
    }
    return defaultValue;
}

function parseMetricsBaseConfig(
    env: Record<string, string | undefined>,
): Pick<IndexerMetricsConfig, "enabled" | "host"> {
    return {
        enabled: parseBoolean(
            env.INDEXER_METRICS_ENABLED,
            "INDEXER_METRICS_ENABLED",
            false,
        ),
        host: readOptionalString(env, ["INDEXER_METRICS_HOST"], "0.0.0.0"),
    };
}
