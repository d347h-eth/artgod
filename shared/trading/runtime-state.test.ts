import { describe, expect, it } from "vitest";
import {
    TRADING_BOT_LIFECYCLE_STATUS,
    TRADING_BOT_RUNTIME_STATE,
} from "../types/trading.js";
import {
    isTradingBotRuntimeHeartbeatLive,
    resolveTradingBotLifecycleStatus,
} from "./runtime-state.js";

const NOW_MS = Date.parse("2026-07-12T12:00:00Z");
const MAX_AGE_MS = 30_000;
const FRESH_HEARTBEAT_AT = "2026-07-12T11:59:50Z";
const STALE_HEARTBEAT_AT = "2026-07-12T11:59:29Z";

describe("trading bot runtime state", () => {
    it("maps fresh bootstrapping and running heartbeats to distinct lifecycle states", () => {
        expect(
            resolveTradingBotLifecycleStatus(
                {
                    state: TRADING_BOT_RUNTIME_STATE.Bootstrapping,
                    heartbeatAt: FRESH_HEARTBEAT_AT,
                },
                NOW_MS,
                MAX_AGE_MS,
            ),
        ).toBe(TRADING_BOT_LIFECYCLE_STATUS.Starting);
        expect(
            resolveTradingBotLifecycleStatus(
                {
                    state: TRADING_BOT_RUNTIME_STATE.Running,
                    heartbeatAt: FRESH_HEARTBEAT_AT,
                },
                NOW_MS,
                MAX_AGE_MS,
            ),
        ).toBe(TRADING_BOT_LIFECYCLE_STATUS.Active);
    });

    it("maps missing, stale, stopped, and error heartbeats to inactive", () => {
        expect(resolveTradingBotLifecycleStatus(null, NOW_MS, MAX_AGE_MS)).toBe(
            TRADING_BOT_LIFECYCLE_STATUS.Inactive,
        );
        expect(
            resolveTradingBotLifecycleStatus(
                {
                    state: TRADING_BOT_RUNTIME_STATE.Running,
                    heartbeatAt: STALE_HEARTBEAT_AT,
                },
                NOW_MS,
                MAX_AGE_MS,
            ),
        ).toBe(TRADING_BOT_LIFECYCLE_STATUS.Inactive);

        for (const state of [
            TRADING_BOT_RUNTIME_STATE.Stopped,
            TRADING_BOT_RUNTIME_STATE.Error,
        ]) {
            expect(
                resolveTradingBotLifecycleStatus(
                    { state, heartbeatAt: FRESH_HEARTBEAT_AT },
                    NOW_MS,
                    MAX_AGE_MS,
                ),
            ).toBe(TRADING_BOT_LIFECYCLE_STATUS.Inactive);
        }
    });

    it("treats only an active lifecycle as a live runtime heartbeat", () => {
        expect(
            isTradingBotRuntimeHeartbeatLive(
                {
                    state: TRADING_BOT_RUNTIME_STATE.Running,
                    heartbeatAt: FRESH_HEARTBEAT_AT,
                },
                NOW_MS,
                MAX_AGE_MS,
            ),
        ).toBe(true);
        expect(
            isTradingBotRuntimeHeartbeatLive(
                {
                    state: TRADING_BOT_RUNTIME_STATE.Bootstrapping,
                    heartbeatAt: FRESH_HEARTBEAT_AT,
                },
                NOW_MS,
                MAX_AGE_MS,
            ),
        ).toBe(false);
    });
});
