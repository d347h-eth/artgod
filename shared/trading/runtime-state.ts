import {
    TRADING_BOT_LIFECYCLE_STATUS,
    TRADING_BOT_RUNTIME_STATE,
    type TradingBotLifecycleStatus,
    type TradingBotRuntimeState,
} from "../types/trading.js";
import {
    DEFAULT_BIDDING_BID_BOOK_SNAPSHOT_STALE_MS,
    DEFAULT_BIDDING_RUNTIME_HEARTBEAT_INTERVAL_MS,
    DEFAULT_BIDDING_RUNTIME_HEARTBEAT_STALE_MS,
} from "../config/bidding.js";

export const TRADING_BOT_RUNTIME_HEARTBEAT_INTERVAL_MS =
    DEFAULT_BIDDING_RUNTIME_HEARTBEAT_INTERVAL_MS;
export const TRADING_BOT_RUNTIME_HEARTBEAT_STALE_MS =
    DEFAULT_BIDDING_RUNTIME_HEARTBEAT_STALE_MS;
export const TRADING_BIDDING_BID_BOOK_SNAPSHOT_STALE_MS =
    DEFAULT_BIDDING_BID_BOOK_SNAPSHOT_STALE_MS;

export type TradingBotRuntimeHeartbeat = {
    state: TradingBotRuntimeState;
    heartbeatAt: string | null;
};

// Resolves the compact lifecycle shown to users from a bounded runtime heartbeat.
export function resolveTradingBotLifecycleStatus(
    heartbeat: TradingBotRuntimeHeartbeat | null,
    nowMs: number = Date.now(),
    maxAgeMs: number = TRADING_BOT_RUNTIME_HEARTBEAT_STALE_MS,
): TradingBotLifecycleStatus {
    if (!isFreshIsoTimestamp(heartbeat?.heartbeatAt ?? null, nowMs, maxAgeMs)) {
        return TRADING_BOT_LIFECYCLE_STATUS.Inactive;
    }
    if (heartbeat?.state === TRADING_BOT_RUNTIME_STATE.Bootstrapping) {
        return TRADING_BOT_LIFECYCLE_STATUS.Starting;
    }
    if (heartbeat?.state === TRADING_BOT_RUNTIME_STATE.Running) {
        return TRADING_BOT_LIFECYCLE_STATUS.Active;
    }
    return TRADING_BOT_LIFECYCLE_STATUS.Inactive;
}

// isTradingBotRuntimeHeartbeatLive checks whether a bot is actively publishing fresh running heartbeats.
export function isTradingBotRuntimeHeartbeatLive(
    heartbeat: TradingBotRuntimeHeartbeat | null,
    nowMs: number = Date.now(),
    maxAgeMs: number = TRADING_BOT_RUNTIME_HEARTBEAT_STALE_MS,
): boolean {
    return (
        resolveTradingBotLifecycleStatus(heartbeat, nowMs, maxAgeMs) ===
        TRADING_BOT_LIFECYCLE_STATUS.Active
    );
}

// isFreshIsoTimestamp validates DB-stored ISO timestamps against a bounded freshness window.
export function isFreshIsoTimestamp(
    value: string | null,
    nowMs: number,
    maxAgeMs: number,
): boolean {
    if (!value) {
        return false;
    }
    const timestampMs = Date.parse(value);
    return Number.isFinite(timestampMs) && nowMs - timestampMs <= maxAgeMs;
}

// isFreshEpochMs validates snapshot timestamps that are already stored as milliseconds since epoch.
export function isFreshEpochMs(
    value: number | null,
    nowMs: number,
    maxAgeMs: number,
): boolean {
    return typeof value === "number" && nowMs - value <= maxAgeMs;
}
