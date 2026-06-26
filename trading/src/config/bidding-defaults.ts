import {
    getSettingDefault,
    getSettingDefaultBoolean,
    getSettingDefaultNumber,
    type SettingsDefaultKey,
} from "@artgod/shared/config/generated-settings-defaults";

// Env keys owned by the trading bidding runtime config parser.
export const BIDDING_RUNTIME_ENV_KEY = {
    Enabled: "BIDDING_ENABLED",
    DryRun: "BIDDING_DRY_RUN",
    PollMs: "BIDDING_POLL_MS",
    MaxConcurrentJobs: "BIDDING_MAX_CONCURRENT_JOBS",
    BootstrapConcurrency: "BIDDING_BOOTSTRAP_CONCURRENCY",
    OfferExpirationSeconds: "BIDDING_OFFER_EXPIRATION_SECONDS",
    CollectionOffersPollMs: "BIDDING_COLLECTION_OFFERS_POLL_MS",
    CollectionOffersTtlMs: "BIDDING_COLLECTION_OFFERS_TTL_MS",
    BidBookProjectionThrottleMs: "BIDDING_BID_BOOK_PROJECTION_THROTTLE_MS",
    OrderLookupMaxPages: "BIDDING_ORDER_LOOKUP_MAX_PAGES",
    OpenSeaSnapshotPageSize: "OPENSEA_SNAPSHOT_PAGE_SIZE",
    CommandPollMs: "BIDDING_COMMAND_POLL_MS",
    CommandBatchSize: "BIDDING_COMMAND_BATCH_SIZE",
    CommandMaxAttempts: "BIDDING_COMMAND_MAX_ATTEMPTS",
    CommandClaimTimeoutMs: "BIDDING_COMMAND_CLAIM_TIMEOUT_MS",
    WethAllowanceEth: "BIDDING_WETH_ALLOWANCE_ETH",
    TxMinPriorityFeeGwei: "BIDDING_TX_MIN_PRIORITY_FEE_GWEI",
    TxFeeHistoryBlocks: "BIDDING_TX_FEE_HISTORY_BLOCKS",
    TxFeeHistoryRewardPercentile: "BIDDING_TX_FEE_HISTORY_REWARD_PERCENTILE",
    TxBaseFeeMultiplier: "BIDDING_TX_BASE_FEE_MULTIPLIER",
    TxMaxFeeGwei: "BIDDING_TX_MAX_FEE_GWEI",
    TxPendingNoncePolicy: "BIDDING_TX_PENDING_NONCE_POLICY",
    CriteriaRefreshTraitsByCollection:
        "BIDDING_CRITERIA_REFRESH_TRAITS_BY_COLLECTION",
    TokenCriteriaTraitsByCollection:
        "BIDDING_TOKEN_CRITERIA_TRAITS_BY_COLLECTION",
    OpenSeaStreamSecretKey: "OPENSEA_STREAM_SECRET_KEY",
    OpenSeaBiddingSecretKey: "OPENSEA_BIDDING_SECRET_KEY",
    OpenSeaSnapshotSecretKey: "OPENSEA_SNAPSHOT_SECRET_KEY",
} as const satisfies Record<string, SettingsDefaultKey>;

// Shared bidding defaults keep runtime config and adapters aligned on the settings manifest.
export const BIDDING_DEFAULT_ENABLED = getSettingDefaultBoolean(
    BIDDING_RUNTIME_ENV_KEY.Enabled,
);
export const BIDDING_DEFAULT_DRY_RUN = getSettingDefaultBoolean(
    BIDDING_RUNTIME_ENV_KEY.DryRun,
);
export const BIDDING_DEFAULT_POLL_MS =
    getSettingDefaultNumber(BIDDING_RUNTIME_ENV_KEY.PollMs);
export const BIDDING_DEFAULT_MAX_CONCURRENT_JOBS = getSettingDefaultNumber(
    BIDDING_RUNTIME_ENV_KEY.MaxConcurrentJobs,
);
export const BIDDING_DEFAULT_BOOTSTRAP_CONCURRENCY = getSettingDefaultNumber(
    BIDDING_RUNTIME_ENV_KEY.BootstrapConcurrency,
);
export const BIDDING_DEFAULT_OFFER_EXPIRATION_SECONDS = getSettingDefaultNumber(
    BIDDING_RUNTIME_ENV_KEY.OfferExpirationSeconds,
);
export const BIDDING_DEFAULT_COLLECTION_OFFERS_POLL_MS =
    getSettingDefaultNumber(BIDDING_RUNTIME_ENV_KEY.CollectionOffersPollMs);
export const BIDDING_DEFAULT_COLLECTION_OFFERS_TTL_MS = getSettingDefaultNumber(
    BIDDING_RUNTIME_ENV_KEY.CollectionOffersTtlMs,
);
export const BIDDING_DEFAULT_BID_BOOK_PROJECTION_THROTTLE_MS =
    getSettingDefaultNumber(
        BIDDING_RUNTIME_ENV_KEY.BidBookProjectionThrottleMs,
    );
export const BIDDING_DEFAULT_ORDER_LOOKUP_MAX_PAGES = getSettingDefaultNumber(
    BIDDING_RUNTIME_ENV_KEY.OrderLookupMaxPages,
);
export const BIDDING_DEFAULT_OPEN_SEA_OFFERS_PAGE_SIZE =
    getSettingDefaultNumber(BIDDING_RUNTIME_ENV_KEY.OpenSeaSnapshotPageSize);
export const BIDDING_DEFAULT_COMMAND_POLL_MS = getSettingDefaultNumber(
    BIDDING_RUNTIME_ENV_KEY.CommandPollMs,
);
export const BIDDING_DEFAULT_COMMAND_BATCH_SIZE = getSettingDefaultNumber(
    BIDDING_RUNTIME_ENV_KEY.CommandBatchSize,
);
export const BIDDING_DEFAULT_COMMAND_MAX_ATTEMPTS = getSettingDefaultNumber(
    BIDDING_RUNTIME_ENV_KEY.CommandMaxAttempts,
);
export const BIDDING_DEFAULT_COMMAND_CLAIM_TIMEOUT_MS = getSettingDefaultNumber(
    BIDDING_RUNTIME_ENV_KEY.CommandClaimTimeoutMs,
);
export const BIDDING_DEFAULT_WETH_ALLOWANCE_ETH = getSettingDefault(
    BIDDING_RUNTIME_ENV_KEY.WethAllowanceEth,
);
export const BIDDING_DEFAULT_TX_MIN_PRIORITY_FEE_GWEI = getSettingDefault(
    BIDDING_RUNTIME_ENV_KEY.TxMinPriorityFeeGwei,
);
export const BIDDING_DEFAULT_TX_FEE_HISTORY_BLOCKS = getSettingDefaultNumber(
    BIDDING_RUNTIME_ENV_KEY.TxFeeHistoryBlocks,
);
export const BIDDING_DEFAULT_TX_FEE_HISTORY_REWARD_PERCENTILE =
    getSettingDefaultNumber(
        BIDDING_RUNTIME_ENV_KEY.TxFeeHistoryRewardPercentile,
    );
export const BIDDING_DEFAULT_TX_BASE_FEE_MULTIPLIER = getSettingDefault(
    BIDDING_RUNTIME_ENV_KEY.TxBaseFeeMultiplier,
);
export const BIDDING_DEFAULT_TX_MAX_FEE_GWEI = getSettingDefault(
    BIDDING_RUNTIME_ENV_KEY.TxMaxFeeGwei,
);
export const BIDDING_DEFAULT_TX_PENDING_NONCE_POLICY = getSettingDefault(
    BIDDING_RUNTIME_ENV_KEY.TxPendingNoncePolicy,
);

// These tracked trait sets preserve the production token-criteria matching behavior by collection.
export const BIDDING_DEFAULT_CRITERIA_REFRESH_TRAITS_BY_COLLECTION =
    parseDefaultTraitMap(
        BIDDING_RUNTIME_ENV_KEY.CriteriaRefreshTraitsByCollection,
    );

export const BIDDING_DEFAULT_TOKEN_CRITERIA_TRAITS_BY_COLLECTION =
    parseDefaultTraitMap(
        BIDDING_RUNTIME_ENV_KEY.TokenCriteriaTraitsByCollection,
    );

function parseDefaultTraitMap(key: Parameters<typeof getSettingDefault>[0]) {
    const parsed = JSON.parse(getSettingDefault(key)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`Invalid settings manifest default ${key}`);
    }
    for (const [collectionSlug, traits] of Object.entries(parsed)) {
        if (
            typeof collectionSlug !== "string" ||
            !Array.isArray(traits) ||
            !traits.every((trait) => typeof trait === "string")
        ) {
            throw new Error(`Invalid settings manifest default ${key}`);
        }
    }
    return parsed as Record<string, string[]>;
}
