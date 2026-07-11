import {
    getSettingDefaultNumber,
    type SettingsDefaultKey,
} from "./generated-settings-defaults.js";
import { parsePositiveInteger } from "../utils/env.js";

// Manifest-backed env keys shared across bidding runtime and UI policy surfaces.
export const BIDDING_CONFIG_ENV_KEY = {
    Enabled: "BIDDING_ENABLED",
    DryRun: "BIDDING_DRY_RUN",
    TrustOpenSeaSignedZoneTraitOffers:
        "BIDDING_TRUST_OPENSEA_SIGNED_ZONE_FOR_TRAIT_OFFERS",
    WethAllowanceCapEth: "BIDDING_WETH_ALLOWANCE_ETH",
    TxMinPriorityFeeGwei: "BIDDING_TX_MIN_PRIORITY_FEE_GWEI",
    TxBaseFeeMultiplier: "BIDDING_TX_BASE_FEE_MULTIPLIER",
    TxMaxFeeGwei: "BIDDING_TX_MAX_FEE_GWEI",
    TxMaxTotalFeeEth: "BIDDING_TX_MAX_TOTAL_FEE_ETH",
    TxPendingNoncePolicy: "BIDDING_TX_PENDING_NONCE_POLICY",
    BidBookSnapshotStaleMs: "BIDDING_BID_BOOK_SNAPSHOT_STALE_MS",
    BidBookNormalLivePollMs: "BIDDING_BID_BOOK_NORMAL_LIVE_POLL_MS",
    BidBookCompetitiveLivePollMs:
        "BIDDING_BID_BOOK_COMPETITIVE_LIVE_POLL_MS",
    RuntimeHeartbeatIntervalMs: "BIDDING_RUNTIME_HEARTBEAT_INTERVAL_MS",
    RuntimeHeartbeatStaleMs: "BIDDING_RUNTIME_HEARTBEAT_STALE_MS",
} as const satisfies Record<string, SettingsDefaultKey>;

export type BiddingBidBookLiveRefreshConfig = {
    normalPollMs: number;
    competitivePollMs: number;
};

export type BiddingConfig = {
    bidBookLiveRefresh: BiddingBidBookLiveRefreshConfig;
    bidBookSnapshotStaleMs: number;
    runtimeHeartbeat: {
        intervalMs: number;
        staleMs: number;
    };
};

// Default UI bid-book live-refresh cadence from the settings manifest.
export const DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG: BiddingBidBookLiveRefreshConfig =
    {
        normalPollMs: getSettingDefaultNumber(
            BIDDING_CONFIG_ENV_KEY.BidBookNormalLivePollMs,
        ),
        competitivePollMs: getSettingDefaultNumber(
            BIDDING_CONFIG_ENV_KEY.BidBookCompetitiveLivePollMs,
        ),
    };

// Default maximum age before backend bid books stop trusting bot snapshots.
export const DEFAULT_BIDDING_BID_BOOK_SNAPSHOT_STALE_MS =
    getSettingDefaultNumber(BIDDING_CONFIG_ENV_KEY.BidBookSnapshotStaleMs);

// Default interval for bidding bot runtime heartbeat writes.
export const DEFAULT_BIDDING_RUNTIME_HEARTBEAT_INTERVAL_MS =
    getSettingDefaultNumber(BIDDING_CONFIG_ENV_KEY.RuntimeHeartbeatIntervalMs);

// Default maximum age before a bidding bot heartbeat is treated as stale.
export const DEFAULT_BIDDING_RUNTIME_HEARTBEAT_STALE_MS =
    getSettingDefaultNumber(BIDDING_CONFIG_ENV_KEY.RuntimeHeartbeatStaleMs);

// Parses bidding runtime tuning from manifest-backed env values.
export function parseBiddingConfig(
    env: Record<string, string | undefined>,
): BiddingConfig {
    return {
        bidBookLiveRefresh: {
            normalPollMs: parsePositiveInteger(
                env[BIDDING_CONFIG_ENV_KEY.BidBookNormalLivePollMs],
                BIDDING_CONFIG_ENV_KEY.BidBookNormalLivePollMs,
                DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG.normalPollMs,
            ),
            competitivePollMs: parsePositiveInteger(
                env[BIDDING_CONFIG_ENV_KEY.BidBookCompetitiveLivePollMs],
                BIDDING_CONFIG_ENV_KEY.BidBookCompetitiveLivePollMs,
                DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG.competitivePollMs,
            ),
        },
        bidBookSnapshotStaleMs: parsePositiveInteger(
            env[BIDDING_CONFIG_ENV_KEY.BidBookSnapshotStaleMs],
            BIDDING_CONFIG_ENV_KEY.BidBookSnapshotStaleMs,
            DEFAULT_BIDDING_BID_BOOK_SNAPSHOT_STALE_MS,
        ),
        runtimeHeartbeat: {
            intervalMs: parsePositiveInteger(
                env[BIDDING_CONFIG_ENV_KEY.RuntimeHeartbeatIntervalMs],
                BIDDING_CONFIG_ENV_KEY.RuntimeHeartbeatIntervalMs,
                DEFAULT_BIDDING_RUNTIME_HEARTBEAT_INTERVAL_MS,
            ),
            staleMs: parsePositiveInteger(
                env[BIDDING_CONFIG_ENV_KEY.RuntimeHeartbeatStaleMs],
                BIDDING_CONFIG_ENV_KEY.RuntimeHeartbeatStaleMs,
                DEFAULT_BIDDING_RUNTIME_HEARTBEAT_STALE_MS,
            ),
        },
    };
}
