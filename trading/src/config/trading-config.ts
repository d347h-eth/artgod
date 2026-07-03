import dotenv from "dotenv";
import {
    getSettingDefault,
    getSettingDefaultBoolean,
    getSettingDefaultNumber,
} from "@artgod/shared/config/generated-settings-defaults";
import {
    parseBiddingConfig,
    type BiddingConfig,
} from "@artgod/shared/config/bidding";
import {
    parseBoolean,
    parseNumber,
    parsePositiveInteger,
    parseRequiredString,
} from "@artgod/shared/utils/env";
import type { EvmTransactionPolicyConfig } from "@artgod/shared/evm/transactions";
import type {
    RpcEndpointResilienceConfig,
    RpcRetryPolicy,
} from "@artgod/shared/evm/rpc-resilience";
import {
    parseRpcEndpointConfigList,
    RPC_ENDPOINT_LIST_ENV_KEY,
    type RpcEndpointConfig,
} from "@artgod/shared/config/rpc-endpoints";
import {
    parseRpcEndpointResilienceConfig,
    parseRpcRetryPolicy,
} from "@artgod/shared/config/rpc-resilience";
import {
    parseOpenSeaHttpConfig,
    type OpenSeaHttpConfig,
} from "@artgod/shared/config/opensea-http";
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
    BIDDING_DEFAULT_COLLECTION_OFFERS_ADAPTIVE_TTL_MULTIPLIER,
    BIDDING_DEFAULT_COLLECTION_OFFERS_MAX_TTL_MS,
    BIDDING_DEFAULT_COLLECTION_OFFERS_TTL_MS,
    BIDDING_DEFAULT_CRITERIA_REFRESH_TRAITS_BY_COLLECTION,
    BIDDING_DEFAULT_DRY_RUN,
    BIDDING_DEFAULT_ENABLED,
    BIDDING_DEFAULT_HOT_REFRESH_BROAD_COOLDOWN_MS,
    BIDDING_DEFAULT_HOT_REFRESH_ITEM_COOLDOWN_MS,
    BIDDING_DEFAULT_MAX_CONCURRENT_JOBS,
    BIDDING_DEFAULT_OFFER_EXPIRATION_SECONDS,
    BIDDING_DEFAULT_ORDER_LOOKUP_MAX_PAGES,
    BIDDING_DEFAULT_SCAN_SLEEP_MS,
    BIDDING_DEFAULT_TOKEN_CRITERIA_TRAITS_BY_COLLECTION,
    BIDDING_DEFAULT_TX_BASE_FEE_MULTIPLIER,
    BIDDING_DEFAULT_TX_FEE_HISTORY_BLOCKS,
    BIDDING_DEFAULT_TX_FEE_HISTORY_REWARD_PERCENTILE,
    BIDDING_DEFAULT_TX_MAX_FEE_GWEI,
    BIDDING_DEFAULT_TX_MIN_PRIORITY_FEE_GWEI,
    BIDDING_DEFAULT_TX_PENDING_NONCE_POLICY,
    BIDDING_DEFAULT_WETH_ALLOWANCE_ETH,
    BIDDING_RUNTIME_ENV_KEY,
} from "./bidding-defaults.js";

// Env keys that own the trading metrics scrape endpoint config.
export const TRADING_METRICS_ENV_KEY = {
    Enabled: "TRADING_METRICS_ENABLED",
    Host: "TRADING_METRICS_HOST",
    PortBiddingBot: "TRADING_METRICS_PORT_BIDDING_BOT",
} as const;

export type TradingMetricsConfig = {
    enabled: boolean;
    host: string;
    ports: {
        biddingBot: number;
    };
};

export type EnabledBiddingConfig = {
    enabled: true;
    dryRun: boolean;
    scanSleepMs: number;
    maxConcurrentJobs: number;
    bootstrapConcurrency: number;
    offerExpirationSeconds: number;
    collectionOffersPollMs: number;
    collectionOffersTtlMs: number;
    collectionOffersMaxTtlMs: number;
    collectionOffersAdaptiveTtlMultiplier: number;
    hotRefreshBroadCooldownMs: number;
    hotRefreshItemCooldownMs: number;
    bidBookProjectionThrottleMs: number;
    orderLookupMaxPages: number;
    commandPollMs: number;
    commandBatchSize: number;
    commandMaxAttempts: number;
    commandClaimTimeoutMs: number;
    runtimeHeartbeat: BiddingConfig["runtimeHeartbeat"];
    criteriaRefreshTraitsByCollection: Record<string, string[]>;
    tokenCriteriaTraitsByCollection: Record<string, string[]>;
    wethAllowanceWei: bigint;
    transactionPolicy: EvmTransactionPolicyConfig;
    openSea: {
        streamSecretKey: string;
        biddingSecretKey: string;
        snapshotSecretKey: string;
        http: OpenSeaHttpConfig;
    };
};

export type DisabledBiddingConfig = {
    enabled: false;
    dryRun: boolean;
    scanSleepMs: number;
    maxConcurrentJobs: number;
    bootstrapConcurrency: number;
    offerExpirationSeconds: number;
    collectionOffersPollMs: number;
    collectionOffersTtlMs: number;
    collectionOffersMaxTtlMs: number;
    collectionOffersAdaptiveTtlMultiplier: number;
    hotRefreshBroadCooldownMs: number;
    hotRefreshItemCooldownMs: number;
    bidBookProjectionThrottleMs: number;
    orderLookupMaxPages: number;
    commandPollMs: number;
    commandBatchSize: number;
    commandMaxAttempts: number;
    commandClaimTimeoutMs: number;
    runtimeHeartbeat: BiddingConfig["runtimeHeartbeat"];
    criteriaRefreshTraitsByCollection: Record<string, string[]>;
    tokenCriteriaTraitsByCollection: Record<string, string[]>;
    wethAllowanceWei: bigint;
    transactionPolicy: EvmTransactionPolicyConfig;
};

export type TradingConfig = {
    dbPath: string;
    chainId: number;
    rpc: {
        endpoints: RpcEndpointConfig[];
        resilience: RpcEndpointResilienceConfig;
        retryPolicy: RpcRetryPolicy;
    };
    queue: {
        natsUrl: string;
        streamPrefix: string;
    };
    tokens: {
        wethAddress: string;
    };
    metrics: TradingMetricsConfig;
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
    const rpcEndpoints = parseRpcEndpointConfigList(
        env[RPC_ENDPOINT_LIST_ENV_KEY],
        RPC_ENDPOINT_LIST_ENV_KEY,
    );
    const rpcRetryPolicy = parseRpcRetryPolicy(env);
    const rpcResilience = parseRpcEndpointResilienceConfig(env);
    const natsUrl = parseRequiredString(env.NATS_URL, "NATS_URL");
    const natsStreamPrefix = parseRequiredString(
        env.NATS_STREAM_PREFIX,
        "NATS_STREAM_PREFIX",
    );
    const wethAddress = parseAddress(env.WETH_ADDRESS, "WETH_ADDRESS");
    const metrics = parseTradingMetricsConfig(env);
    const sharedBiddingConfig = parseBiddingConfig(env);

    const biddingBase = {
        dryRun: parseBoolean(
            env[BIDDING_RUNTIME_ENV_KEY.DryRun],
            BIDDING_RUNTIME_ENV_KEY.DryRun,
            BIDDING_DEFAULT_DRY_RUN,
        ),
        scanSleepMs: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.ScanSleepMs],
            BIDDING_RUNTIME_ENV_KEY.ScanSleepMs,
            BIDDING_DEFAULT_SCAN_SLEEP_MS,
        ),
        maxConcurrentJobs: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.MaxConcurrentJobs],
            BIDDING_RUNTIME_ENV_KEY.MaxConcurrentJobs,
            BIDDING_DEFAULT_MAX_CONCURRENT_JOBS,
        ),
        bootstrapConcurrency: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.BootstrapConcurrency],
            BIDDING_RUNTIME_ENV_KEY.BootstrapConcurrency,
            BIDDING_DEFAULT_BOOTSTRAP_CONCURRENCY,
        ),
        offerExpirationSeconds: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.OfferExpirationSeconds],
            BIDDING_RUNTIME_ENV_KEY.OfferExpirationSeconds,
            BIDDING_DEFAULT_OFFER_EXPIRATION_SECONDS,
        ),
        collectionOffersPollMs: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.CollectionOffersPollMs],
            BIDDING_RUNTIME_ENV_KEY.CollectionOffersPollMs,
            BIDDING_DEFAULT_COLLECTION_OFFERS_POLL_MS,
        ),
        collectionOffersTtlMs: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.CollectionOffersTtlMs],
            BIDDING_RUNTIME_ENV_KEY.CollectionOffersTtlMs,
            BIDDING_DEFAULT_COLLECTION_OFFERS_TTL_MS,
        ),
        collectionOffersMaxTtlMs: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.CollectionOffersMaxTtlMs],
            BIDDING_RUNTIME_ENV_KEY.CollectionOffersMaxTtlMs,
            BIDDING_DEFAULT_COLLECTION_OFFERS_MAX_TTL_MS,
        ),
        collectionOffersAdaptiveTtlMultiplier: parsePositiveNumber(
            env[BIDDING_RUNTIME_ENV_KEY.CollectionOffersAdaptiveTtlMultiplier],
            BIDDING_RUNTIME_ENV_KEY.CollectionOffersAdaptiveTtlMultiplier,
            BIDDING_DEFAULT_COLLECTION_OFFERS_ADAPTIVE_TTL_MULTIPLIER,
        ),
        hotRefreshBroadCooldownMs: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.HotRefreshBroadCooldownMs],
            BIDDING_RUNTIME_ENV_KEY.HotRefreshBroadCooldownMs,
            BIDDING_DEFAULT_HOT_REFRESH_BROAD_COOLDOWN_MS,
        ),
        hotRefreshItemCooldownMs: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.HotRefreshItemCooldownMs],
            BIDDING_RUNTIME_ENV_KEY.HotRefreshItemCooldownMs,
            BIDDING_DEFAULT_HOT_REFRESH_ITEM_COOLDOWN_MS,
        ),
        bidBookProjectionThrottleMs: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.BidBookProjectionThrottleMs],
            BIDDING_RUNTIME_ENV_KEY.BidBookProjectionThrottleMs,
            BIDDING_DEFAULT_BID_BOOK_PROJECTION_THROTTLE_MS,
        ),
        orderLookupMaxPages: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.OrderLookupMaxPages],
            BIDDING_RUNTIME_ENV_KEY.OrderLookupMaxPages,
            BIDDING_DEFAULT_ORDER_LOOKUP_MAX_PAGES,
        ),
        commandPollMs: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.CommandPollMs],
            BIDDING_RUNTIME_ENV_KEY.CommandPollMs,
            BIDDING_DEFAULT_COMMAND_POLL_MS,
        ),
        commandBatchSize: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.CommandBatchSize],
            BIDDING_RUNTIME_ENV_KEY.CommandBatchSize,
            BIDDING_DEFAULT_COMMAND_BATCH_SIZE,
        ),
        commandMaxAttempts: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.CommandMaxAttempts],
            BIDDING_RUNTIME_ENV_KEY.CommandMaxAttempts,
            BIDDING_DEFAULT_COMMAND_MAX_ATTEMPTS,
        ),
        commandClaimTimeoutMs: parsePositiveInteger(
            env[BIDDING_RUNTIME_ENV_KEY.CommandClaimTimeoutMs],
            BIDDING_RUNTIME_ENV_KEY.CommandClaimTimeoutMs,
            BIDDING_DEFAULT_COMMAND_CLAIM_TIMEOUT_MS,
        ),
        runtimeHeartbeat: sharedBiddingConfig.runtimeHeartbeat,
        criteriaRefreshTraitsByCollection: parseStringArrayMap(
            env[BIDDING_RUNTIME_ENV_KEY.CriteriaRefreshTraitsByCollection],
            BIDDING_DEFAULT_CRITERIA_REFRESH_TRAITS_BY_COLLECTION,
            BIDDING_RUNTIME_ENV_KEY.CriteriaRefreshTraitsByCollection,
        ),
        tokenCriteriaTraitsByCollection: parseStringArrayMap(
            env[BIDDING_RUNTIME_ENV_KEY.TokenCriteriaTraitsByCollection],
            BIDDING_DEFAULT_TOKEN_CRITERIA_TRAITS_BY_COLLECTION,
            BIDDING_RUNTIME_ENV_KEY.TokenCriteriaTraitsByCollection,
        ),
        wethAllowanceWei: parseNonNegativeEtherToWei(
            env[BIDDING_RUNTIME_ENV_KEY.WethAllowanceEth],
            BIDDING_RUNTIME_ENV_KEY.WethAllowanceEth,
            BIDDING_DEFAULT_WETH_ALLOWANCE_ETH,
        ),
        transactionPolicy: parseBiddingTransactionPolicy(env),
    };

    const biddingEnabled = parseBoolean(
        env[BIDDING_RUNTIME_ENV_KEY.Enabled],
        BIDDING_RUNTIME_ENV_KEY.Enabled,
        BIDDING_DEFAULT_ENABLED,
    );

    return {
        dbPath,
        chainId,
        rpc: {
            endpoints: rpcEndpoints,
            resilience: rpcResilience,
            retryPolicy: rpcRetryPolicy,
        },
        queue: {
            natsUrl,
            streamPrefix: natsStreamPrefix,
        },
        tokens: {
            wethAddress,
        },
        metrics,
        bidding: biddingEnabled
            ? {
                  enabled: true,
                  ...biddingBase,
                  openSea: parseOpenSeaConfig(env),
              }
            : {
                  enabled: false,
                  ...biddingBase,
              },
    };
}

function parseOpenSeaConfig(env: Record<string, string | undefined>): {
    streamSecretKey: string;
    biddingSecretKey: string;
    snapshotSecretKey: string;
    http: OpenSeaHttpConfig;
} {
    const secrets = {
        streamSecretKey: parseRequiredString(
            env[BIDDING_RUNTIME_ENV_KEY.OpenSeaStreamSecretKey],
            BIDDING_RUNTIME_ENV_KEY.OpenSeaStreamSecretKey,
        ),
        biddingSecretKey: parseRequiredString(
            env[BIDDING_RUNTIME_ENV_KEY.OpenSeaBiddingSecretKey],
            BIDDING_RUNTIME_ENV_KEY.OpenSeaBiddingSecretKey,
        ),
        snapshotSecretKey: parseRequiredString(
            env[BIDDING_RUNTIME_ENV_KEY.OpenSeaSnapshotSecretKey],
            BIDDING_RUNTIME_ENV_KEY.OpenSeaSnapshotSecretKey,
        ),
        http: parseOpenSeaHttpConfig(env),
    };

    return secrets;
}

function parseTradingMetricsConfig(
    env: Record<string, string | undefined>,
): TradingMetricsConfig {
    return {
        enabled: parseBoolean(
            env[TRADING_METRICS_ENV_KEY.Enabled],
            TRADING_METRICS_ENV_KEY.Enabled,
            getSettingDefaultBoolean(TRADING_METRICS_ENV_KEY.Enabled),
        ),
        host: parseRequiredString(
            env[TRADING_METRICS_ENV_KEY.Host] ??
                getSettingDefault(TRADING_METRICS_ENV_KEY.Host),
            TRADING_METRICS_ENV_KEY.Host,
        ),
        ports: {
            biddingBot: parsePositiveInteger(
                env[TRADING_METRICS_ENV_KEY.PortBiddingBot],
                TRADING_METRICS_ENV_KEY.PortBiddingBot,
                getSettingDefaultNumber(TRADING_METRICS_ENV_KEY.PortBiddingBot),
            ),
        },
    };
}

function parseBiddingTransactionPolicy(
    env: Record<string, string | undefined>,
): EvmTransactionPolicyConfig {
    return {
        fees: {
            minPriorityFeePerGasWei: parsePositiveGweiToWei(
                env[BIDDING_RUNTIME_ENV_KEY.TxMinPriorityFeeGwei],
                BIDDING_RUNTIME_ENV_KEY.TxMinPriorityFeeGwei,
                BIDDING_DEFAULT_TX_MIN_PRIORITY_FEE_GWEI,
            ),
            priorityFeeHistoryBlockCount: parseFeeHistoryBlockCount(
                env[BIDDING_RUNTIME_ENV_KEY.TxFeeHistoryBlocks],
                BIDDING_RUNTIME_ENV_KEY.TxFeeHistoryBlocks,
                BIDDING_DEFAULT_TX_FEE_HISTORY_BLOCKS,
            ),
            priorityFeeHistoryRewardPercentile: parseRewardPercentile(
                env[BIDDING_RUNTIME_ENV_KEY.TxFeeHistoryRewardPercentile],
                BIDDING_RUNTIME_ENV_KEY.TxFeeHistoryRewardPercentile,
                BIDDING_DEFAULT_TX_FEE_HISTORY_REWARD_PERCENTILE,
            ),
            baseFeeMultiplierBps: parseBaseFeeMultiplierBps(
                env[BIDDING_RUNTIME_ENV_KEY.TxBaseFeeMultiplier],
                BIDDING_RUNTIME_ENV_KEY.TxBaseFeeMultiplier,
                BIDDING_DEFAULT_TX_BASE_FEE_MULTIPLIER,
            ),
            maxFeePerGasWei: parsePositiveGweiToWei(
                env[BIDDING_RUNTIME_ENV_KEY.TxMaxFeeGwei],
                BIDDING_RUNTIME_ENV_KEY.TxMaxFeeGwei,
                BIDDING_DEFAULT_TX_MAX_FEE_GWEI,
            ),
        },
        nonce: {
            pendingNoncePolicy: parsePendingNoncePolicy(
                env[BIDDING_RUNTIME_ENV_KEY.TxPendingNoncePolicy],
                BIDDING_RUNTIME_ENV_KEY.TxPendingNoncePolicy,
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

function parsePositiveNumber(
    value: string | undefined,
    name: string,
    defaultValue: number,
): number {
    const parsed = parseNumber(value, name, defaultValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
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
