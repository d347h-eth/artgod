import { dirname, isAbsolute, resolve } from "node:path";
import dotenv from "dotenv";
import {
    parseBoolean,
    parseNumber,
    parsePositiveInteger,
    parseRequiredString,
} from "@artgod/shared/utils/env";
import { resolveRuntimeEnvPath } from "@artgod/shared/utils/runtime-env";
import {
    BIDDING_DEFAULT_BOOTSTRAP_CONCURRENCY,
    BIDDING_DEFAULT_COLLECTION_OFFERS_POLL_MS,
    BIDDING_DEFAULT_COLLECTION_OFFERS_TTL_MS,
    BIDDING_DEFAULT_CRITERIA_REFRESH_TRAITS_BY_COLLECTION,
    BIDDING_DEFAULT_MAX_CONCURRENT_JOBS,
    BIDDING_DEFAULT_OFFER_EXPIRATION_SECONDS,
    BIDDING_DEFAULT_ORDER_LOOKUP_MAX_PAGES,
    BIDDING_DEFAULT_POLL_MS,
    BIDDING_DEFAULT_TOKEN_CRITERIA_TRAITS_BY_COLLECTION,
} from "./bidding-defaults.js";

export type EnabledBiddingConfig = {
    enabled: true;
    dryRun: boolean;
    pollMs: number;
    maxConcurrentJobs: number;
    bootstrapConcurrency: number;
    offerExpirationSeconds: number;
    collectionOffersPollMs: number;
    collectionOffersTtlMs: number;
    orderLookupMaxPages: number;
    criteriaRefreshTraitsByCollection: Record<string, string[]>;
    tokenCriteriaTraitsByCollection: Record<string, string[]>;
    jobsFile: string;
    openSea: {
        streamSecretKey: string;
        biddingSecretKey: string;
        snapshotSecretKey: string;
    };
};

export type DisabledBiddingConfig = {
    enabled: false;
    dryRun: boolean;
    pollMs: number;
    maxConcurrentJobs: number;
    bootstrapConcurrency: number;
    offerExpirationSeconds: number;
    collectionOffersPollMs: number;
    collectionOffersTtlMs: number;
    orderLookupMaxPages: number;
    criteriaRefreshTraitsByCollection: Record<string, string[]>;
    tokenCriteriaTraitsByCollection: Record<string, string[]>;
};

export type TradingConfig = {
    dbPath: string;
    chainId: number;
    rpc: {
        primaryUrl: string;
    };
    tokens: {
        wethAddress: string;
    };
    bidding: EnabledBiddingConfig | DisabledBiddingConfig;
};

type LoadTradingConfigOptions = {
    envFilePath?: string;
    hydrateProcessEnv?: boolean;
};

// Loads the typed trading env surface and resolves path-like fields needed by the bidding runtime.
export function loadTradingConfig(
    env: Record<string, string | undefined> = process.env,
    options: LoadTradingConfigOptions = {},
): TradingConfig {
    const envFilePath =
        options.envFilePath ?? resolveRuntimeEnvPath(env, ".env");
    if (env === process.env && options.hydrateProcessEnv !== false) {
        dotenv.config({ path: envFilePath });
    }

    const dbPath = parseRequiredString(env.ARTGOD_DB_PATH, "ARTGOD_DB_PATH");
    const chainId = parseNumber(env.CHAIN_ID, "CHAIN_ID", 1);
    const rpcUrl = parseRequiredString(env.RPC_URL, "RPC_URL");
    const wethAddress = parseAddress(env.WETH_ADDRESS, "WETH_ADDRESS");

    const biddingBase = {
        dryRun: parseBoolean(env.BIDDING_DRY_RUN, "BIDDING_DRY_RUN", false),
        pollMs: parsePositiveInteger(
            env.BIDDING_POLL_MS,
            "BIDDING_POLL_MS",
            BIDDING_DEFAULT_POLL_MS,
        ),
        maxConcurrentJobs: parsePositiveInteger(
            env.BIDDING_MAX_CONCURRENT_JOBS,
            "BIDDING_MAX_CONCURRENT_JOBS",
            BIDDING_DEFAULT_MAX_CONCURRENT_JOBS,
        ),
        bootstrapConcurrency: parsePositiveInteger(
            env.BIDDING_BOOTSTRAP_CONCURRENCY,
            "BIDDING_BOOTSTRAP_CONCURRENCY",
            BIDDING_DEFAULT_BOOTSTRAP_CONCURRENCY,
        ),
        offerExpirationSeconds: parsePositiveInteger(
            env.BIDDING_OFFER_EXPIRATION_SECONDS,
            "BIDDING_OFFER_EXPIRATION_SECONDS",
            BIDDING_DEFAULT_OFFER_EXPIRATION_SECONDS,
        ),
        collectionOffersPollMs: parsePositiveInteger(
            env.BIDDING_COLLECTION_OFFERS_POLL_MS,
            "BIDDING_COLLECTION_OFFERS_POLL_MS",
            BIDDING_DEFAULT_COLLECTION_OFFERS_POLL_MS,
        ),
        collectionOffersTtlMs: parsePositiveInteger(
            env.BIDDING_COLLECTION_OFFERS_TTL_MS,
            "BIDDING_COLLECTION_OFFERS_TTL_MS",
            BIDDING_DEFAULT_COLLECTION_OFFERS_TTL_MS,
        ),
        orderLookupMaxPages: parsePositiveInteger(
            env.BIDDING_ORDER_LOOKUP_MAX_PAGES,
            "BIDDING_ORDER_LOOKUP_MAX_PAGES",
            BIDDING_DEFAULT_ORDER_LOOKUP_MAX_PAGES,
        ),
        criteriaRefreshTraitsByCollection: parseStringArrayMap(
            env.BIDDING_CRITERIA_REFRESH_TRAITS_BY_COLLECTION,
            BIDDING_DEFAULT_CRITERIA_REFRESH_TRAITS_BY_COLLECTION,
            "BIDDING_CRITERIA_REFRESH_TRAITS_BY_COLLECTION",
        ),
        tokenCriteriaTraitsByCollection: parseStringArrayMap(
            env.BIDDING_TOKEN_CRITERIA_TRAITS_BY_COLLECTION,
            BIDDING_DEFAULT_TOKEN_CRITERIA_TRAITS_BY_COLLECTION,
            "BIDDING_TOKEN_CRITERIA_TRAITS_BY_COLLECTION",
        ),
    };

    const biddingEnabled = parseBoolean(
        env.BIDDING_ENABLED,
        "BIDDING_ENABLED",
        true,
    );

    return {
        dbPath,
        chainId,
        rpc: {
            primaryUrl: rpcUrl,
        },
        tokens: {
            wethAddress,
        },
        bidding: biddingEnabled
            ? {
                  enabled: true,
                  ...biddingBase,
                  jobsFile: resolveRelativeToEnvFile(
                      parseRequiredString(
                          env.BIDDING_JOBS_FILE,
                          "BIDDING_JOBS_FILE",
                      ),
                      envFilePath,
                  ),
                  openSea: parseOpenSeaSecrets(env),
              }
            : {
                  enabled: false,
                  ...biddingBase,
              },
    };
}

function parseOpenSeaSecrets(env: Record<string, string | undefined>): {
    streamSecretKey: string;
    biddingSecretKey: string;
    snapshotSecretKey: string;
} {
    const secrets = {
        streamSecretKey: parseRequiredString(
            env.OPENSEA_STREAM_SECRET_KEY,
            "OPENSEA_STREAM_SECRET_KEY",
        ),
        biddingSecretKey: parseRequiredString(
            env.OPENSEA_BIDDING_SECRET_KEY,
            "OPENSEA_BIDDING_SECRET_KEY",
        ),
        snapshotSecretKey: parseRequiredString(
            env.OPENSEA_SNAPSHOT_SECRET_KEY,
            "OPENSEA_SNAPSHOT_SECRET_KEY",
        ),
    };

    const seen = new Map<string, string>();
    for (const [fieldName, value] of Object.entries(secrets)) {
        const existing = seen.get(value);
        if (existing) {
            throw new Error(
                `OpenSea bot secret keys must stay split by lane. ${fieldName} duplicates ${existing}`,
            );
        }
        seen.set(value, fieldName);
    }

    return secrets;
}

function parseAddress(value: string | undefined, name: string): string {
    const normalized = parseRequiredString(value, name);
    if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return normalized.toLowerCase();
}

function parseStringArrayMap(
    value: string | undefined,
    defaultValue: Record<string, string[]>,
    name: string,
): Record<string, string[]> {
    if (value === undefined || value.trim() === "") {
        return defaultValue;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error(`Invalid ${name}: ${value}`);
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid ${name}: expected an object map`);
    }

    const normalized: Record<string, string[]> = {};
    for (const [rawKey, rawValue] of Object.entries(parsed)) {
        const key = rawKey.trim();
        if (!key) {
            throw new Error(`Invalid ${name}: collection key cannot be empty`);
        }
        if (!Array.isArray(rawValue)) {
            throw new Error(`Invalid ${name}: ${key} must map to an array`);
        }

        normalized[key] = rawValue.map((entry) => {
            if (typeof entry !== "string" || entry.trim() === "") {
                throw new Error(
                    `Invalid ${name}: ${key} contains an empty trait name`,
                );
            }
            return entry.trim();
        });
    }

    return normalized;
}

function resolveRelativeToEnvFile(
    configuredPath: string,
    envFilePath: string,
): string {
    if (isAbsolute(configuredPath)) {
        return configuredPath;
    }

    return resolve(dirname(envFilePath), configuredPath);
}
