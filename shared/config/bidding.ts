import {
    getSettingDefaultNumber,
    type SettingsDefaultKey,
} from "./generated-settings-defaults.js";
import { parsePositiveInteger } from "../utils/env.js";

// Env keys that tune bid-book freshness and live-refresh behavior.
export const BIDDING_CONFIG_ENV_KEY = {
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
