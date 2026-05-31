import dotenv from "dotenv";
import {
    parseBoolean,
    parseNumber,
    parsePositiveInteger,
    parseRequiredString,
} from "@artgod/shared/utils/env";
import type { EvmTransactionPolicyConfig } from "@artgod/shared/evm/transactions";
import {
    parseRpcEndpointConfigList,
    type RpcEndpointConfig,
} from "@artgod/shared/config/rpc-endpoints";
import { resolveRuntimeEnvPath } from "@artgod/shared/utils/runtime-env";
import { parseEther, parseGwei } from "viem";
import {
    BIDDING_DEFAULT_BOOTSTRAP_CONCURRENCY,
    BIDDING_DEFAULT_BID_BOOK_PROJECTION_THROTTLE_MS,
    BIDDING_DEFAULT_COMMAND_BATCH_SIZE,
    BIDDING_DEFAULT_COMMAND_CLAIM_TIMEOUT_MS,
    BIDDING_DEFAULT_COMMAND_MAX_ATTEMPTS,
    BIDDING_DEFAULT_COMMAND_POLL_MS,
    BIDDING_DEFAULT_COLLECTION_OFFERS_POLL_MS,
    BIDDING_DEFAULT_COLLECTION_OFFERS_TTL_MS,
    BIDDING_DEFAULT_CRITERIA_REFRESH_TRAITS_BY_COLLECTION,
    BIDDING_DEFAULT_MAX_CONCURRENT_JOBS,
    BIDDING_DEFAULT_OFFER_EXPIRATION_SECONDS,
    BIDDING_DEFAULT_ORDER_LOOKUP_MAX_PAGES,
    BIDDING_DEFAULT_POLL_MS,
    BIDDING_DEFAULT_TOKEN_CRITERIA_TRAITS_BY_COLLECTION,
    BIDDING_DEFAULT_TX_BASE_FEE_MULTIPLIER,
    BIDDING_DEFAULT_TX_FEE_HISTORY_BLOCKS,
    BIDDING_DEFAULT_TX_FEE_HISTORY_REWARD_PERCENTILE,
    BIDDING_DEFAULT_TX_MAX_FEE_GWEI,
    BIDDING_DEFAULT_TX_MIN_PRIORITY_FEE_GWEI,
    BIDDING_DEFAULT_TX_PENDING_NONCE_POLICY,
    BIDDING_DEFAULT_WETH_ALLOWANCE_ETH,
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
    bidBookProjectionThrottleMs: number;
    orderLookupMaxPages: number;
    commandPollMs: number;
    commandBatchSize: number;
    commandMaxAttempts: number;
    commandClaimTimeoutMs: number;
    criteriaRefreshTraitsByCollection: Record<string, string[]>;
    tokenCriteriaTraitsByCollection: Record<string, string[]>;
    wethAllowanceWei: bigint;
    transactionPolicy: EvmTransactionPolicyConfig;
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
    bidBookProjectionThrottleMs: number;
    orderLookupMaxPages: number;
    commandPollMs: number;
    commandBatchSize: number;
    commandMaxAttempts: number;
    commandClaimTimeoutMs: number;
    criteriaRefreshTraitsByCollection: Record<string, string[]>;
    tokenCriteriaTraitsByCollection: Record<string, string[]>;
    wethAllowanceWei: bigint;
    transactionPolicy: EvmTransactionPolicyConfig;
};

export type TradingConfig = {
    dbPath: string;
    chainId: number;
    rpc: {
        primaryUrl: string;
        endpoints: RpcEndpointConfig[];
    };
    queue: {
        natsUrl: string;
        streamPrefix: string;
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

// Loads the typed trading env surface needed by the bidding runtime.
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
    const rpcEndpoints = parseRpcEndpointConfigList(env.RPC_URL, "RPC_URL");
    const rpcUrl = rpcEndpoints[0]?.url ?? "";
    const natsUrl = parseRequiredString(env.NATS_URL, "NATS_URL");
    const natsStreamPrefix = parseRequiredString(
        env.NATS_STREAM_PREFIX,
        "NATS_STREAM_PREFIX",
    );
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
        bidBookProjectionThrottleMs: parsePositiveInteger(
            env.BIDDING_BID_BOOK_PROJECTION_THROTTLE_MS,
            "BIDDING_BID_BOOK_PROJECTION_THROTTLE_MS",
            BIDDING_DEFAULT_BID_BOOK_PROJECTION_THROTTLE_MS,
        ),
        orderLookupMaxPages: parsePositiveInteger(
            env.BIDDING_ORDER_LOOKUP_MAX_PAGES,
            "BIDDING_ORDER_LOOKUP_MAX_PAGES",
            BIDDING_DEFAULT_ORDER_LOOKUP_MAX_PAGES,
        ),
        commandPollMs: parsePositiveInteger(
            env.BIDDING_COMMAND_POLL_MS,
            "BIDDING_COMMAND_POLL_MS",
            BIDDING_DEFAULT_COMMAND_POLL_MS,
        ),
        commandBatchSize: parsePositiveInteger(
            env.BIDDING_COMMAND_BATCH_SIZE,
            "BIDDING_COMMAND_BATCH_SIZE",
            BIDDING_DEFAULT_COMMAND_BATCH_SIZE,
        ),
        commandMaxAttempts: parsePositiveInteger(
            env.BIDDING_COMMAND_MAX_ATTEMPTS,
            "BIDDING_COMMAND_MAX_ATTEMPTS",
            BIDDING_DEFAULT_COMMAND_MAX_ATTEMPTS,
        ),
        commandClaimTimeoutMs: parsePositiveInteger(
            env.BIDDING_COMMAND_CLAIM_TIMEOUT_MS,
            "BIDDING_COMMAND_CLAIM_TIMEOUT_MS",
            BIDDING_DEFAULT_COMMAND_CLAIM_TIMEOUT_MS,
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
        wethAllowanceWei: parseNonNegativeEtherToWei(
            env.BIDDING_WETH_ALLOWANCE_ETH,
            "BIDDING_WETH_ALLOWANCE_ETH",
            BIDDING_DEFAULT_WETH_ALLOWANCE_ETH,
        ),
        transactionPolicy: parseBiddingTransactionPolicy(env),
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
            endpoints: rpcEndpoints,
        },
        queue: {
            natsUrl,
            streamPrefix: natsStreamPrefix,
        },
        tokens: {
            wethAddress,
        },
        bidding: biddingEnabled
            ? {
                  enabled: true,
                  ...biddingBase,
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

    return secrets;
}

function parseBiddingTransactionPolicy(
    env: Record<string, string | undefined>,
): EvmTransactionPolicyConfig {
    return {
        fees: {
            minPriorityFeePerGasWei: parsePositiveGweiToWei(
                env.BIDDING_TX_MIN_PRIORITY_FEE_GWEI,
                "BIDDING_TX_MIN_PRIORITY_FEE_GWEI",
                BIDDING_DEFAULT_TX_MIN_PRIORITY_FEE_GWEI,
            ),
            priorityFeeHistoryBlockCount: parseFeeHistoryBlockCount(
                env.BIDDING_TX_FEE_HISTORY_BLOCKS,
                "BIDDING_TX_FEE_HISTORY_BLOCKS",
                BIDDING_DEFAULT_TX_FEE_HISTORY_BLOCKS,
            ),
            priorityFeeHistoryRewardPercentile: parseRewardPercentile(
                env.BIDDING_TX_FEE_HISTORY_REWARD_PERCENTILE,
                "BIDDING_TX_FEE_HISTORY_REWARD_PERCENTILE",
                BIDDING_DEFAULT_TX_FEE_HISTORY_REWARD_PERCENTILE,
            ),
            baseFeeMultiplierBps: parseBaseFeeMultiplierBps(
                env.BIDDING_TX_BASE_FEE_MULTIPLIER,
                "BIDDING_TX_BASE_FEE_MULTIPLIER",
                BIDDING_DEFAULT_TX_BASE_FEE_MULTIPLIER,
            ),
            maxFeePerGasWei: parsePositiveGweiToWei(
                env.BIDDING_TX_MAX_FEE_GWEI,
                "BIDDING_TX_MAX_FEE_GWEI",
                BIDDING_DEFAULT_TX_MAX_FEE_GWEI,
            ),
        },
        nonce: {
            pendingNoncePolicy: parsePendingNoncePolicy(
                env.BIDDING_TX_PENDING_NONCE_POLICY,
                "BIDDING_TX_PENDING_NONCE_POLICY",
                BIDDING_DEFAULT_TX_PENDING_NONCE_POLICY,
            ),
        },
    };
}

function parseAddress(value: string | undefined, name: string): string {
    const normalized = parseRequiredString(value, name);
    if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return normalized.toLowerCase();
}

function parseNonNegativeEtherToWei(
    value: string | undefined,
    name: string,
    defaultValue: string,
): bigint {
    const normalized = value?.trim() || defaultValue;
    if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(normalized)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    try {
        return parseEther(normalized);
    } catch {
        throw new Error(`Invalid ${name}: ${value}`);
    }
}

function parsePositiveGweiToWei(
    value: string | undefined,
    name: string,
    defaultValue: string,
): bigint {
    const normalized = value?.trim() || defaultValue;
    if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(normalized)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    try {
        const parsed = parseGwei(normalized);
        if (parsed <= 0n) {
            throw new Error(`Invalid ${name}: ${value}`);
        }
        return parsed;
    } catch {
        throw new Error(`Invalid ${name}: ${value}`);
    }
}

function parseBaseFeeMultiplierBps(
    value: string | undefined,
    name: string,
    defaultValue: string,
): bigint {
    const normalized = value?.trim() || defaultValue;
    if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(normalized)) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    const [wholePart, fractionPart = ""] = normalized.split(".");
    if (fractionPart.length > 4) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    const basisPoints =
        BigInt(wholePart) * 10_000n +
        BigInt(fractionPart.padEnd(4, "0") || "0");
    if (basisPoints < 10_000n) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return basisPoints;
}

function parseRewardPercentile(
    value: string | undefined,
    name: string,
    defaultValue: number,
): number {
    const parsed = parseNumber(value, name, defaultValue);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return parsed;
}

function parseFeeHistoryBlockCount(
    value: string | undefined,
    name: string,
    defaultValue: number,
): number {
    const parsed = parsePositiveInteger(value, name, defaultValue);
    if (parsed > 1024) {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return parsed;
}

function parsePendingNoncePolicy(
    value: string | undefined,
    name: string,
    defaultValue: string,
): "fail" {
    const normalized = (value?.trim() || defaultValue).toLowerCase();
    if (normalized !== "fail") {
        throw new Error(`Invalid ${name}: ${value}`);
    }
    return "fail";
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
