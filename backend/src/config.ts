import dotenv from "dotenv";
import { resolveRuntimeEnvPath } from "@artgod/shared/utils";
import { normalizeSlugRef } from "@artgod/shared/utils/ref-resolver";
import {
    parseBoolean,
    parsePositiveInteger,
    parseRequiredString,
} from "@artgod/shared/utils/env";
import {
    QUERY_CACHE_PROVIDERS,
    type QueryCacheProvider,
} from "./ports/query-cache.js";

dotenv.config({ path: resolveRuntimeEnvPath(process.env, ".env") });

const DEFAULT_BACKEND_HOST = "127.0.0.1";
const DEFAULT_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "::1"];
const DEFAULT_ALLOWED_ORIGINS = [
    "http://127.0.0.1:3000",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "http://localhost:5173",
];
const DEFAULT_BACKEND_QUERY_CACHE_MAX_ENTRIES = 500;
const DEFAULT_BACKEND_QUERY_CACHE_COLLECTION_DETAIL_DEFAULT_TTL_MS = 10000;
const DEFAULT_BACKEND_QUERY_CACHE_TOKEN_PREVIEW_MAX_ENTRIES = 250;
const DEFAULT_BACKEND_QUERY_CACHE_TOKEN_PREVIEW_FRESH_MS = 10 * 60 * 1000;
const DEFAULT_BACKEND_QUERY_CACHE_TOKEN_PREVIEW_STALE_MS = 20 * 60 * 1000;
const DEFAULT_BACKEND_QUERY_CACHE_TOKEN_PREVIEW_WARMUP_CONCURRENCY = 3;

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
    maxEntries: number;
    collectionDetailDefaultTtlMs: number;
    tokenPreview: {
        maxEntries: number;
        freshMs: number;
        staleMs: number;
        warmupConcurrency: number;
    };
};

export type BackendConfig = {
    host: string;
    port: number;
    defaultChainId: number;
    dbPath: string;
    wethAddress: string;
    natsUrl: string;
    natsStreamPrefix: string;
    userlandUiDistDir: string | null;
    security: BackendSecurityConfig;
    deployment: BackendDeploymentConfig;
    queryCache: BackendQueryCacheConfig;
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

export function loadBackendConfig(
    env: Record<string, string | undefined> = process.env,
): BackendConfig {
    const host = parseHost(env.BACKEND_HOST);
    const port = parsePositiveInteger(env.BACKEND_PORT, "BACKEND_PORT", 3000);
    const defaultChainId = parsePositiveInteger(env.CHAIN_ID, "CHAIN_ID", 1);
    const dbPath = parseRequiredString(env.ARTGOD_DB_PATH, "ARTGOD_DB_PATH");
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
            false,
        ),
    };
    const deployment = parseDeploymentConfig(env);
    const queryCache = parseQueryCacheConfig(env);

    return {
        host,
        port,
        defaultChainId,
        dbPath,
        wethAddress,
        natsUrl,
        natsStreamPrefix,
        userlandUiDistDir,
        security,
        deployment,
        queryCache,
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
        maxEntries: parsePositiveInteger(
            env.BACKEND_QUERY_CACHE_MAX_ENTRIES,
            "BACKEND_QUERY_CACHE_MAX_ENTRIES",
            DEFAULT_BACKEND_QUERY_CACHE_MAX_ENTRIES,
        ),
        collectionDetailDefaultTtlMs: parsePositiveInteger(
            env.BACKEND_QUERY_CACHE_COLLECTION_DETAIL_DEFAULT_TTL_MS,
            "BACKEND_QUERY_CACHE_COLLECTION_DETAIL_DEFAULT_TTL_MS",
            DEFAULT_BACKEND_QUERY_CACHE_COLLECTION_DETAIL_DEFAULT_TTL_MS,
        ),
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
    const rawMode = env.PUBLIC_APP_DEPLOYMENT_MODE?.trim() || "";
    if (!rawMode || rawMode === "standard") {
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
        value?.trim().toLowerCase() ?? QUERY_CACHE_PROVIDERS.Disabled;
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
    let parsed: URL;
    try {
        parsed = new URL(entry);
    } catch {
        throw new Error(`Invalid BACKEND_ALLOWED_ORIGINS entry: ${entry}`);
    }

    if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
        throw new Error(`Invalid BACKEND_ALLOWED_ORIGINS entry: ${entry}`);
    }

    return parsed.origin.toLowerCase();
}
