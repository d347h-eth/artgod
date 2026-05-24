import {
    getSettingDefault,
    getSettingDefaultBoolean,
    getSettingDefaultNumber,
} from "@artgod/shared/config/generated-settings-defaults";
import { parseBoolean, parseNumber } from "@artgod/shared/utils/env";

export const DEFAULT_INDEXER_APM_SERVICE_NAMESPACE = getSettingDefault(
    "INDEXER_APM_SERVICE_NAMESPACE",
);
export const DEFAULT_OBSERVABILITY_OTLP_HTTP_URL = getSettingDefault(
    "OBSERVABILITY_OTLP_HTTP_URL",
);
export const DEFAULT_OBSERVABILITY_PYROSCOPE_URL = getSettingDefault(
    "OBSERVABILITY_PYROSCOPE_URL",
);
const DEFAULT_INDEXER_APM_ENABLED = getSettingDefaultBoolean(
    "INDEXER_APM_ENABLED",
);
const DEFAULT_INDEXER_APM_SPAN_PROFILES_ENABLED = getSettingDefaultBoolean(
    "INDEXER_APM_SPAN_PROFILES_ENABLED",
);
const DEFAULT_INDEXER_APM_TRACES_ENABLED = getSettingDefaultBoolean(
    "INDEXER_APM_TRACES_ENABLED",
);
const DEFAULT_INDEXER_APM_PROFILES_ENABLED = getSettingDefaultBoolean(
    "INDEXER_APM_PROFILES_ENABLED",
);
const DEFAULT_INDEXER_METRICS_ENABLED = getSettingDefaultBoolean(
    "INDEXER_METRICS_ENABLED",
);
const DEFAULT_INDEXER_METRICS_HOST = getSettingDefault("INDEXER_METRICS_HOST");
const DEFAULT_INDEXER_METRICS_PORTS: IndexerMetricsPortsConfig = {
    schedulerWorker: getSettingDefaultNumber(
        "INDEXER_METRICS_PORT_SCHEDULER_WORKER",
    ),
    syncWorker: getSettingDefaultNumber("INDEXER_METRICS_PORT_SYNC_WORKER"),
    reorgWorker: getSettingDefaultNumber("INDEXER_METRICS_PORT_REORG_WORKER"),
    domainWorker: getSettingDefaultNumber("INDEXER_METRICS_PORT_DOMAIN_WORKER"),
    offchainIngestWorker: getSettingDefaultNumber(
        "INDEXER_METRICS_PORT_OFFCHAIN_INGEST_WORKER",
    ),
    openseaStreamWorker: getSettingDefaultNumber(
        "INDEXER_METRICS_PORT_OPENSEA_STREAM_WORKER",
    ),
    openseaBootstrapWorker: getSettingDefaultNumber(
        "INDEXER_METRICS_PORT_OPENSEA_BOOTSTRAP_WORKER",
    ),
    openseaReconcileWorker: getSettingDefaultNumber(
        "INDEXER_METRICS_PORT_OPENSEA_RECONCILE_WORKER",
    ),
    openseaReconcileSchedulerWorker: getSettingDefaultNumber(
        "INDEXER_METRICS_PORT_OPENSEA_RECONCILE_SCHEDULER_WORKER",
    ),
    bootstrapWorker: getSettingDefaultNumber(
        "INDEXER_METRICS_PORT_BOOTSTRAP_WORKER",
    ),
    collectionExtensionWorker: getSettingDefaultNumber(
        "INDEXER_METRICS_PORT_COLLECTION_EXTENSION_WORKER",
    ),
    deadLetterWorker: getSettingDefaultNumber(
        "INDEXER_METRICS_PORT_DEAD_LETTER_WORKER",
    ),
};

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
            DEFAULT_INDEXER_APM_ENABLED,
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
                DEFAULT_INDEXER_APM_SPAN_PROFILES_ENABLED,
            ),
        },
        traces: {
            enabled: parseBoolean(
                env.INDEXER_APM_TRACES_ENABLED,
                "INDEXER_APM_TRACES_ENABLED",
                DEFAULT_INDEXER_APM_TRACES_ENABLED,
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
                DEFAULT_INDEXER_APM_PROFILES_ENABLED,
            ),
            pyroscopeUrl: readOptionalString(
                env,
                ["INDEXER_APM_PYROSCOPE_URL", "OBSERVABILITY_PYROSCOPE_URL"],
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
                DEFAULT_INDEXER_METRICS_PORTS.schedulerWorker,
            ),
            syncWorker: parseNumber(
                env.INDEXER_METRICS_PORT_SYNC_WORKER,
                "INDEXER_METRICS_PORT_SYNC_WORKER",
                DEFAULT_INDEXER_METRICS_PORTS.syncWorker,
            ),
            reorgWorker: parseNumber(
                env.INDEXER_METRICS_PORT_REORG_WORKER,
                "INDEXER_METRICS_PORT_REORG_WORKER",
                DEFAULT_INDEXER_METRICS_PORTS.reorgWorker,
            ),
            domainWorker: parseNumber(
                env.INDEXER_METRICS_PORT_DOMAIN_WORKER,
                "INDEXER_METRICS_PORT_DOMAIN_WORKER",
                DEFAULT_INDEXER_METRICS_PORTS.domainWorker,
            ),
            offchainIngestWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OFFCHAIN_INGEST_WORKER,
                "INDEXER_METRICS_PORT_OFFCHAIN_INGEST_WORKER",
                DEFAULT_INDEXER_METRICS_PORTS.offchainIngestWorker,
            ),
            openseaStreamWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_STREAM_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_STREAM_WORKER",
                DEFAULT_INDEXER_METRICS_PORTS.openseaStreamWorker,
            ),
            openseaBootstrapWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_BOOTSTRAP_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_BOOTSTRAP_WORKER",
                DEFAULT_INDEXER_METRICS_PORTS.openseaBootstrapWorker,
            ),
            openseaReconcileWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_RECONCILE_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_RECONCILE_WORKER",
                DEFAULT_INDEXER_METRICS_PORTS.openseaReconcileWorker,
            ),
            openseaReconcileSchedulerWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_RECONCILE_SCHEDULER_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_RECONCILE_SCHEDULER_WORKER",
                DEFAULT_INDEXER_METRICS_PORTS.openseaReconcileSchedulerWorker,
            ),
            bootstrapWorker: parseNumber(
                env.INDEXER_METRICS_PORT_BOOTSTRAP_WORKER,
                "INDEXER_METRICS_PORT_BOOTSTRAP_WORKER",
                DEFAULT_INDEXER_METRICS_PORTS.bootstrapWorker,
            ),
            collectionExtensionWorker: parseNumber(
                env.INDEXER_METRICS_PORT_COLLECTION_EXTENSION_WORKER,
                "INDEXER_METRICS_PORT_COLLECTION_EXTENSION_WORKER",
                DEFAULT_INDEXER_METRICS_PORTS.collectionExtensionWorker,
            ),
            deadLetterWorker: parseNumber(
                env.INDEXER_METRICS_PORT_DEAD_LETTER_WORKER,
                "INDEXER_METRICS_PORT_DEAD_LETTER_WORKER",
                DEFAULT_INDEXER_METRICS_PORTS.deadLetterWorker,
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
                DEFAULT_INDEXER_METRICS_PORTS.openseaStreamWorker,
            ),
            openseaBootstrapWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_BOOTSTRAP_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_BOOTSTRAP_WORKER",
                DEFAULT_INDEXER_METRICS_PORTS.openseaBootstrapWorker,
            ),
            openseaReconcileWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_RECONCILE_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_RECONCILE_WORKER",
                DEFAULT_INDEXER_METRICS_PORTS.openseaReconcileWorker,
            ),
            openseaReconcileSchedulerWorker: parseNumber(
                env.INDEXER_METRICS_PORT_OPENSEA_RECONCILE_SCHEDULER_WORKER,
                "INDEXER_METRICS_PORT_OPENSEA_RECONCILE_SCHEDULER_WORKER",
                DEFAULT_INDEXER_METRICS_PORTS.openseaReconcileSchedulerWorker,
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
            DEFAULT_INDEXER_METRICS_ENABLED,
        ),
        host: readOptionalString(
            env,
            ["INDEXER_METRICS_HOST"],
            DEFAULT_INDEXER_METRICS_HOST,
        ),
    };
}
