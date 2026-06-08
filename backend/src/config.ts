import dotenv from "dotenv";
import { resolveRuntimeEnvPath } from "@artgod/shared/utils";
import { normalizeSlugRef } from "@artgod/shared/utils/ref-resolver";
import {
    assertOpenSeaIntegrationModeSatisfied,
    resolveOpenSeaIntegrationStatus,
    type OpenSeaIntegrationStatus,
} from "@artgod/shared/config/opensea-integration";
import {
    getSettingDefault,
    getSettingDefaultBoolean,
    getSettingDefaultCsv,
    getSettingDefaultNumber,
} from "@artgod/shared/config/generated-settings-defaults";
import { COMMON_MEDIA_ENV_KEY } from "@artgod/shared/config/common-media";
import {
    parseRpcEndpointConfigList,
    RPC_ENDPOINT_LIST_ENV_KEY,
    type RpcEndpointConfig,
} from "@artgod/shared/config/rpc-endpoints";
import {
    parseRpcEndpointResilienceConfig,
    parseRpcRetryPolicy,
} from "@artgod/shared/config/rpc-resilience";
import { parseHttpFetchResilienceConfig } from "@artgod/shared/config/http-fetch-resilience";
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
import type { HttpFetchResilienceConfig } from "@artgod/shared/network/http-fetch-resilience";
import { normalizeIpfsGatewayOrigin } from "@artgod/shared/media/token-resource-uri";
import { resolveTokenImageCacheDir } from "@artgod/shared/media/token-image-cache-storage";
import {
    QUERY_CACHE_PROVIDERS,
    type QueryCacheProvider,
} from "./ports/query-cache.js";
import { normalizeOrigin } from "./http/common/origin-policy.js";

dotenv.config({ path: resolveRuntimeEnvPath(process.env, ".env") });

const DEFAULT_BACKEND_HOST = getSettingDefault("BACKEND_HOST");
const DEFAULT_BACKEND_PORT = getSettingDefaultNumber("BACKEND_PORT");
const DEFAULT_CHAIN_ID = getSettingDefaultNumber("CHAIN_ID");
const DEFAULT_ALLOWED_HOSTS = getSettingDefaultCsv("BACKEND_ALLOWED_HOSTS");
const DEFAULT_ALLOWED_ORIGINS = getSettingDefaultCsv("BACKEND_ALLOWED_ORIGINS");
const DEFAULT_BACKEND_CSRF_COOKIE_SECURE = getSettingDefaultBoolean(
    "BACKEND_CSRF_COOKIE_SECURE",
);
const DEFAULT_BACKFILL_BATCH_SIZE = getSettingDefaultNumber(
    "BACKFILL_BATCH_SIZE",
);
const DEFAULT_BACKEND_QUERY_CACHE_PROVIDER = getSettingDefault(
    "BACKEND_QUERY_CACHE_PROVIDER",
);
const DEFAULT_BACKEND_PUBLIC_COLLECTION_CACHE_REFRESH_MS =
    getSettingDefaultNumber("BACKEND_PUBLIC_COLLECTION_CACHE_REFRESH_MS");
const DEFAULT_BACKEND_PUBLIC_COLLECTION_PREVIEW_WARM_REFRESH_MS =
    getSettingDefaultNumber(
        "BACKEND_PUBLIC_COLLECTION_PREVIEW_WARM_REFRESH_MS",
    );
const DEFAULT_BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS =
    getSettingDefaultNumber("BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS");
const DEFAULT_BACKEND_QUERY_CACHE_TOKEN_PREVIEW_MAX_ENTRIES =
    getSettingDefaultNumber("BACKEND_QUERY_CACHE_TOKEN_PREVIEW_MAX_ENTRIES");
const DEFAULT_BACKEND_QUERY_CACHE_TOKEN_PREVIEW_FRESH_MS =
    getSettingDefaultNumber("BACKEND_QUERY_CACHE_TOKEN_PREVIEW_FRESH_MS");
const DEFAULT_BACKEND_QUERY_CACHE_TOKEN_PREVIEW_STALE_MS =
    getSettingDefaultNumber("BACKEND_QUERY_CACHE_TOKEN_PREVIEW_STALE_MS");
const DEFAULT_BACKEND_QUERY_CACHE_TOKEN_PREVIEW_WARMUP_CONCURRENCY =
    getSettingDefaultNumber(
        "BACKEND_QUERY_CACHE_TOKEN_PREVIEW_WARMUP_CONCURRENCY",
    );
const DEFAULT_BACKEND_METRICS_ENABLED = getSettingDefaultBoolean(
    "BACKEND_METRICS_ENABLED",
);
const DEFAULT_BACKEND_METRICS_HOST = getSettingDefault("BACKEND_METRICS_HOST");
const DEFAULT_BACKEND_METRICS_PORT = getSettingDefaultNumber(
    "BACKEND_METRICS_PORT",
);
const DEFAULT_BACKEND_APM_ENABLED = getSettingDefaultBoolean(
    "BACKEND_APM_ENABLED",
);
const DEFAULT_BACKEND_APM_SERVICE_NAMESPACE = getSettingDefault(
    "BACKEND_APM_SERVICE_NAMESPACE",
);
const DEFAULT_BACKEND_APM_SPAN_PROFILES_ENABLED = getSettingDefaultBoolean(
    "BACKEND_APM_SPAN_PROFILES_ENABLED",
);
const DEFAULT_BACKEND_APM_TRACES_ENABLED = getSettingDefaultBoolean(
    "BACKEND_APM_TRACES_ENABLED",
);
const DEFAULT_BACKEND_APM_PROFILES_ENABLED = getSettingDefaultBoolean(
    "BACKEND_APM_PROFILES_ENABLED",
);
const DEFAULT_OBSERVABILITY_OTLP_HTTP_URL = getSettingDefault(
    "OBSERVABILITY_OTLP_HTTP_URL",
);
const DEFAULT_OBSERVABILITY_PYROSCOPE_URL = getSettingDefault(
    "OBSERVABILITY_PYROSCOPE_URL",
);
const DEFAULT_PUBLIC_APP_DEPLOYMENT_MODE = getSettingDefault(
    "PUBLIC_APP_DEPLOYMENT_MODE",
);
const DEFAULT_COMMON_IPFS_GATEWAY_ORIGIN = getSettingDefault(
    COMMON_MEDIA_ENV_KEY.IpfsGatewayOrigin,
);
const DEFAULT_COMMON_MEDIA_CACHE_DIR = getSettingDefault(
    COMMON_MEDIA_ENV_KEY.MediaCacheDir,
);

export type BackendSecurityConfig = {
    allowedHosts: string[];
    allowedOrigins: string[];
    csrfCookieSecure: boolean;
};

export type BackendDeploymentMode = "standard" | "public_single_collection";

export type BackendPublicCollectionScope = {
    chainRef: string;
    collectionRef: string;
};

export type BackendDeploymentConfig = {
    mode: BackendDeploymentMode;
    publicCollectionScope: BackendPublicCollectionScope | null;
};

export type BackendQueryCacheConfig = {
    provider: QueryCacheProvider;
    publicCollection: {
        detailRefreshMs: number;
        previewWarmRefreshMs: number;
    };
    publicBlockspace: {
        refreshMs: number;
    };
    tokenPreview: {
        maxEntries: number;
        freshMs: number;
        staleMs: number;
        warmupConcurrency: number;
    };
};

export type BackendMetricsConfig = {
    enabled: boolean;
    host: string;
    port: number;
};

export type BackendApmConfig = {
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

export type BackendSyncConfig = {
    backfillBatchSize: number;
};

export type BackendConfig = {
    host: string;
    port: number;
    defaultChainId: number;
    dbPath: string;
    rpc: {
        endpoints: RpcEndpointConfig[];
        retryPolicy: RpcRetryPolicy;
        resilience: RpcEndpointResilienceConfig;
    };
    wethAddress: string;
    natsUrl: string;
    natsStreamPrefix: string;
    userlandUiDistDir: string | null;
    security: BackendSecurityConfig;
    deployment: BackendDeploymentConfig;
    queryCache: BackendQueryCacheConfig;
    sync: BackendSyncConfig;
    ipfs: {
        gatewayOrigin: string;
    };
    mediaCache: {
        tokenImagesDir: string;
    };
    httpFetch: HttpFetchResilienceConfig;
    metrics: BackendMetricsConfig;
    apm: BackendApmConfig;
    integrations: {
        opensea: OpenSeaIntegrationStatus;
    };
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

export function loadBackendConfig(
    env: Record<string, string | undefined> = process.env,
): BackendConfig {
    const host = parseHost(env.BACKEND_HOST);
    const port = parsePositiveInteger(
        env.BACKEND_PORT,
        "BACKEND_PORT",
        DEFAULT_BACKEND_PORT,
    );
    const defaultChainId = parsePositiveInteger(
        env.CHAIN_ID,
        "CHAIN_ID",
        DEFAULT_CHAIN_ID,
    );
    const dbPath = parseRequiredString(env.ARTGOD_DB_PATH, "ARTGOD_DB_PATH");
    const rpcEndpoints = parseRpcEndpointConfigList(
        env[RPC_ENDPOINT_LIST_ENV_KEY],
        RPC_ENDPOINT_LIST_ENV_KEY,
    );
    const wethAddress = parseAddress(env.WETH_ADDRESS, "WETH_ADDRESS");
    const natsUrl = parseRequiredString(env.NATS_URL, "NATS_URL");
    const natsStreamPrefix = parseRequiredString(
        env.NATS_STREAM_PREFIX,
        "NATS_STREAM_PREFIX",
    );
    const userlandUiDistDir = env.USERLAND_UI_DIST_DIR?.trim() || null;
    const security: BackendSecurityConfig = {
        allowedHosts: parseAllowedHosts(env.BACKEND_ALLOWED_HOSTS),
        allowedOrigins: parseAllowedOrigins(env.BACKEND_ALLOWED_ORIGINS),
        csrfCookieSecure: parseBoolean(
            env.BACKEND_CSRF_COOKIE_SECURE,
            "BACKEND_CSRF_COOKIE_SECURE",
            DEFAULT_BACKEND_CSRF_COOKIE_SECURE,
        ),
    };
    const deployment = parseDeploymentConfig(env);
    const queryCache = parseQueryCacheConfig(env);
    const sync = parseBackendSyncConfig(env);
    const ipfsGatewayOrigin = normalizeIpfsGatewayOrigin(
        env[COMMON_MEDIA_ENV_KEY.IpfsGatewayOrigin] ??
            DEFAULT_COMMON_IPFS_GATEWAY_ORIGIN,
    );
    const tokenImagesDir = resolveTokenImageCacheDir({
        dbPath,
        overrideDir:
            env[COMMON_MEDIA_ENV_KEY.MediaCacheDir] ??
            DEFAULT_COMMON_MEDIA_CACHE_DIR,
    });
    const metrics = parseBackendMetricsConfig(env);
    const apm = parseBackendApmConfig(env);
    const openseaIntegration = resolveOpenSeaIntegrationStatus(env);
    assertOpenSeaIntegrationModeSatisfied(openseaIntegration);
    const integrations = {
        opensea: openseaIntegration,
    };

    return {
        host,
        port,
        defaultChainId,
        dbPath,
        rpc: {
            endpoints: rpcEndpoints,
            retryPolicy: parseRpcRetryPolicy(env),
            resilience: parseRpcEndpointResilienceConfig(env),
        },
        wethAddress,
        natsUrl,
        natsStreamPrefix,
        userlandUiDistDir,
        security,
        deployment,
        queryCache,
        sync,
        ipfs: {
            gatewayOrigin: ipfsGatewayOrigin,
        },
        mediaCache: {
            tokenImagesDir,
        },
        httpFetch: parseHttpFetchResilienceConfig(env),
        metrics,
        apm,
        integrations,
    };
}

function parseBackendSyncConfig(
    env: Record<string, string | undefined>,
): BackendSyncConfig {
    return {
        backfillBatchSize: parsePositiveInteger(
            env.BACKFILL_BATCH_SIZE,
            "BACKFILL_BATCH_SIZE",
            DEFAULT_BACKFILL_BATCH_SIZE,
        ),
    };
}

function parseBackendMetricsConfig(
    env: Record<string, string | undefined>,
): BackendMetricsConfig {
    return {
        enabled: parseBoolean(
            env.BACKEND_METRICS_ENABLED,
            "BACKEND_METRICS_ENABLED",
            DEFAULT_BACKEND_METRICS_ENABLED,
        ),
        host: env.BACKEND_METRICS_HOST?.trim() || DEFAULT_BACKEND_METRICS_HOST,
        port: parsePositiveInteger(
            env.BACKEND_METRICS_PORT,
            "BACKEND_METRICS_PORT",
            DEFAULT_BACKEND_METRICS_PORT,
        ),
    };
}

function parseBackendApmConfig(
    env: Record<string, string | undefined>,
): BackendApmConfig {
    return {
        enabled: parseBoolean(
            env.BACKEND_APM_ENABLED,
            "BACKEND_APM_ENABLED",
            DEFAULT_BACKEND_APM_ENABLED,
        ),
        serviceNamespace:
            env.BACKEND_APM_SERVICE_NAMESPACE?.trim() ||
            DEFAULT_BACKEND_APM_SERVICE_NAMESPACE,
        spanProfiles: {
            enabled: parseBoolean(
                env.BACKEND_APM_SPAN_PROFILES_ENABLED,
                "BACKEND_APM_SPAN_PROFILES_ENABLED",
                DEFAULT_BACKEND_APM_SPAN_PROFILES_ENABLED,
            ),
        },
        traces: {
            enabled: parseBoolean(
                env.BACKEND_APM_TRACES_ENABLED,
                "BACKEND_APM_TRACES_ENABLED",
                DEFAULT_BACKEND_APM_TRACES_ENABLED,
            ),
            otlpHttpUrl:
                env.BACKEND_APM_OTLP_HTTP_URL?.trim() ||
                env.OBSERVABILITY_OTLP_HTTP_URL?.trim() ||
                DEFAULT_OBSERVABILITY_OTLP_HTTP_URL,
        },
        profiles: {
            enabled: parseBoolean(
                env.BACKEND_APM_PROFILES_ENABLED,
                "BACKEND_APM_PROFILES_ENABLED",
                DEFAULT_BACKEND_APM_PROFILES_ENABLED,
            ),
            pyroscopeUrl:
                env.BACKEND_APM_PYROSCOPE_URL?.trim() ||
                env.OBSERVABILITY_PYROSCOPE_URL?.trim() ||
                DEFAULT_OBSERVABILITY_PYROSCOPE_URL,
        },
    };
}

function parseQueryCacheConfig(
    env: Record<string, string | undefined>,
): BackendQueryCacheConfig {
    const provider = parseQueryCacheProvider(env.BACKEND_QUERY_CACHE_PROVIDER);
    const tokenPreviewFreshMs = parsePositiveInteger(
        env.BACKEND_QUERY_CACHE_TOKEN_PREVIEW_FRESH_MS,
        "BACKEND_QUERY_CACHE_TOKEN_PREVIEW_FRESH_MS",
        DEFAULT_BACKEND_QUERY_CACHE_TOKEN_PREVIEW_FRESH_MS,
    );
    const tokenPreviewStaleMs = parsePositiveInteger(
        env.BACKEND_QUERY_CACHE_TOKEN_PREVIEW_STALE_MS,
        "BACKEND_QUERY_CACHE_TOKEN_PREVIEW_STALE_MS",
        DEFAULT_BACKEND_QUERY_CACHE_TOKEN_PREVIEW_STALE_MS,
    );
    if (tokenPreviewStaleMs < tokenPreviewFreshMs) {
        throw new Error(
            "BACKEND_QUERY_CACHE_TOKEN_PREVIEW_STALE_MS must be greater than or equal to BACKEND_QUERY_CACHE_TOKEN_PREVIEW_FRESH_MS",
        );
    }

    return {
        provider,
        publicCollection: {
            detailRefreshMs: parsePositiveInteger(
                env.BACKEND_PUBLIC_COLLECTION_CACHE_REFRESH_MS,
                "BACKEND_PUBLIC_COLLECTION_CACHE_REFRESH_MS",
                DEFAULT_BACKEND_PUBLIC_COLLECTION_CACHE_REFRESH_MS,
            ),
            previewWarmRefreshMs: parsePositiveInteger(
                env.BACKEND_PUBLIC_COLLECTION_PREVIEW_WARM_REFRESH_MS,
                "BACKEND_PUBLIC_COLLECTION_PREVIEW_WARM_REFRESH_MS",
                DEFAULT_BACKEND_PUBLIC_COLLECTION_PREVIEW_WARM_REFRESH_MS,
            ),
        },
        publicBlockspace: {
            refreshMs: parsePositiveInteger(
                env.BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS,
                "BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS",
                DEFAULT_BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS,
            ),
        },
        tokenPreview: {
            maxEntries: parsePositiveInteger(
                env.BACKEND_QUERY_CACHE_TOKEN_PREVIEW_MAX_ENTRIES,
                "BACKEND_QUERY_CACHE_TOKEN_PREVIEW_MAX_ENTRIES",
                DEFAULT_BACKEND_QUERY_CACHE_TOKEN_PREVIEW_MAX_ENTRIES,
            ),
            freshMs: tokenPreviewFreshMs,
            staleMs: tokenPreviewStaleMs,
            warmupConcurrency: parsePositiveInteger(
                env.BACKEND_QUERY_CACHE_TOKEN_PREVIEW_WARMUP_CONCURRENCY,
                "BACKEND_QUERY_CACHE_TOKEN_PREVIEW_WARMUP_CONCURRENCY",
                DEFAULT_BACKEND_QUERY_CACHE_TOKEN_PREVIEW_WARMUP_CONCURRENCY,
            ),
        },
    };
}

function parseDeploymentConfig(
    env: Record<string, string | undefined>,
): BackendDeploymentConfig {
    const rawMode =
        env.PUBLIC_APP_DEPLOYMENT_MODE?.trim() ||
        DEFAULT_PUBLIC_APP_DEPLOYMENT_MODE;
    if (rawMode === "standard") {
        return {
            mode: "standard",
            publicCollectionScope: null,
        };
    }
    if (rawMode !== "public_single_collection") {
        throw new Error(`Invalid PUBLIC_APP_DEPLOYMENT_MODE: ${rawMode}`);
    }

    const rawChainRef = parseRequiredString(
        env.PUBLIC_APP_CHAIN_REF,
        "PUBLIC_APP_CHAIN_REF",
    );
    const rawCollectionRef = parseRequiredString(
        env.PUBLIC_APP_COLLECTION_REF,
        "PUBLIC_APP_COLLECTION_REF",
    );

    return {
        mode: "public_single_collection",
        publicCollectionScope: {
            chainRef: normalizeSlugRef(rawChainRef),
            collectionRef: normalizeSlugRef(rawCollectionRef),
        },
    };
}

function parseQueryCacheProvider(
    value: string | undefined,
): QueryCacheProvider {
    const normalized =
        value?.trim().toLowerCase() ?? DEFAULT_BACKEND_QUERY_CACHE_PROVIDER;
    if (normalized === QUERY_CACHE_PROVIDERS.Disabled) {
        return QUERY_CACHE_PROVIDERS.Disabled;
    }
    if (normalized === QUERY_CACHE_PROVIDERS.Memory) {
        return QUERY_CACHE_PROVIDERS.Memory;
    }
    throw new Error(`Invalid BACKEND_QUERY_CACHE_PROVIDER: ${value}`);
}

function parseHost(value: string | undefined): string {
    const normalized = value?.trim();
    if (!normalized) {
        return DEFAULT_BACKEND_HOST;
    }
    return normalized;
}

function parseAllowedHosts(value: string | undefined): string[] {
    const entries = splitCsv(value, DEFAULT_ALLOWED_HOSTS);
    return entries.map((entry) => normalizeAllowedHostEntry(entry));
}

function parseAllowedOrigins(value: string | undefined): string[] {
    const entries = splitCsv(value, DEFAULT_ALLOWED_ORIGINS);
    return entries.map((entry) => normalizeAllowedOriginEntry(entry));
}

function splitCsv(
    value: string | undefined,
    defaultValues: string[],
): string[] {
    const normalized = value?.trim();
    if (!normalized) {
        return [...defaultValues];
    }
    const entries = normalized
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    if (entries.length === 0) {
        return [...defaultValues];
    }
    return entries;
}

function normalizeAllowedHostEntry(entry: string): string {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) {
        throw new Error("Invalid BACKEND_ALLOWED_HOSTS entry: empty value");
    }

    if (normalized.includes("://")) {
        let parsed: URL;
        try {
            parsed = new URL(normalized);
        } catch {
            throw new Error(`Invalid BACKEND_ALLOWED_HOSTS entry: ${entry}`);
        }
        return parsed.hostname.toLowerCase();
    }

    if (normalized.startsWith("[")) {
        const end = normalized.indexOf("]");
        if (end > 0) {
            return normalized.slice(1, end);
        }
    }

    if (normalized.indexOf(":") !== normalized.lastIndexOf(":")) {
        return normalized;
    }

    const colonIndex = normalized.indexOf(":");
    if (colonIndex >= 0) {
        return normalized.slice(0, colonIndex);
    }

    return normalized;
}

function normalizeAllowedOriginEntry(entry: string): string {
    const normalized = normalizeOrigin(entry);
    if (!normalized) {
        throw new Error(`Invalid BACKEND_ALLOWED_ORIGINS entry: ${entry}`);
    }
    return normalized;
}
