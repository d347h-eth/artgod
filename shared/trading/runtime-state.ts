import {
    TRADING_BOT_RUNTIME_STATE,
    type TradingBotRuntimeState,
} from "../types/trading.js";

export const TRADING_BOT_RUNTIME_HEARTBEAT_INTERVAL_MS = 10_000;
export const TRADING_BOT_RUNTIME_HEARTBEAT_STALE_MS = 30_000;
export const TRADING_BIDDING_BID_BOOK_SNAPSHOT_STALE_MS = 120_000;

export type TradingBotRuntimeHeartbeat = {
    state: TradingBotRuntimeState;
    heartbeatAt: string | null;
};

// isTradingBotRuntimeHeartbeatLive checks whether a bot is actively publishing fresh running heartbeats.
export function isTradingBotRuntimeHeartbeatLive(
    heartbeat: TradingBotRuntimeHeartbeat | null,
    nowMs: number = Date.now(),
): boolean {
    return (
        heartbeat?.state === TRADING_BOT_RUNTIME_STATE.Running &&
        isFreshIsoTimestamp(
            heartbeat.heartbeatAt,
            nowMs,
            TRADING_BOT_RUNTIME_HEARTBEAT_STALE_MS,
        )
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
