import { db } from "@artgod/shared/database";
import type { BetterSqlite3NamedStatement } from "@artgod/shared/database";
import { TRADING_BOT_RUNTIME_HEARTBEAT_INTERVAL_MS } from "@artgod/shared/trading/runtime-state";
import type {
    TradingBotKind,
    TradingBotRuntimeState,
} from "@artgod/shared/types";

export type TradingBotRuntimeIdentity = {
    botKind: TradingBotKind;
    chainId: number;
    walletId: string;
    address: string;
};

type UpsertRuntimeStateParams = TradingBotRuntimeIdentity & {
    state: TradingBotRuntimeState;
    heartbeatAt: string;
    startedAt: string;
    updatedAt: string;
    lastError: string | null;
};

export class SqliteTradingBotRuntimeState {
    private readonly upsertRuntimeState: BetterSqlite3NamedStatement<UpsertRuntimeStateParams>;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private activeSession:
        | {
              identity: TradingBotRuntimeIdentity;
              startedAt: string;
          }
        | null = null;

    constructor(
        private readonly heartbeatIntervalMs: number = TRADING_BOT_RUNTIME_HEARTBEAT_INTERVAL_MS,
    ) {
        this.upsertRuntimeState = db.prepare<UpsertRuntimeStateParams>(
            "INSERT INTO trading_bot_runtime_state " +
                "(bot_kind, chain_id, wallet_id, address, state, heartbeat_at, started_at, updated_at, last_error) " +
                "VALUES (@botKind, @chainId, @walletId, @address, @state, @heartbeatAt, @startedAt, @updatedAt, @lastError) " +
                "ON CONFLICT(bot_kind, chain_id, wallet_id) DO UPDATE SET " +
                "address = excluded.address, " +
                "state = excluded.state, " +
                "heartbeat_at = excluded.heartbeat_at, " +
                "started_at = excluded.started_at, " +
                "updated_at = excluded.updated_at, " +
                "last_error = excluded.last_error",
        ) as BetterSqlite3NamedStatement<UpsertRuntimeStateParams>;
    }

    // startHeartbeat publishes a fresh bot process heartbeat until shutdown or the state changes.
    startHeartbeat(
        identity: TradingBotRuntimeIdentity,
        state: TradingBotRuntimeState,
    ): void {
        this.stopHeartbeat();
        const startedAt =
            this.activeSession &&
            runtimeIdentityKey(this.activeSession.identity) ===
                runtimeIdentityKey(identity)
                ? this.activeSession.startedAt
                : new Date().toISOString();
        this.activeSession = { identity, startedAt };
        this.writeState(identity, state, startedAt, null);
        this.heartbeatTimer = setInterval(() => {
            this.writeState(identity, state, startedAt, null);
        }, this.heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();
    }

    // markState writes an immediate one-shot lifecycle state transition for backend readers.
    markState(
        identity: TradingBotRuntimeIdentity,
        state: TradingBotRuntimeState,
        lastError: string | null = null,
    ): void {
        const startedAt =
            this.activeSession &&
            runtimeIdentityKey(this.activeSession.identity) ===
                runtimeIdentityKey(identity)
                ? this.activeSession.startedAt
                : new Date().toISOString();
        this.activeSession = { identity, startedAt };
        this.writeState(identity, state, startedAt, lastError);
    }

    // stopHeartbeat prevents stale timer writes after the supervised bot is shutting down.
    stopHeartbeat(): void {
        if (!this.heartbeatTimer) {
            return;
        }
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    private writeState(
        identity: TradingBotRuntimeIdentity,
        state: TradingBotRuntimeState,
        startedAt: string,
        lastError: string | null,
    ): void {
        const now = new Date().toISOString();
        // Persist the heartbeat in SQLite so backend read paths can decide whether bot snapshots are live.
        this.upsertRuntimeState.run({
            ...identity,
            state,
            heartbeatAt: now,
            startedAt,
            updatedAt: now,
            lastError,
        });
    }
}

function runtimeIdentityKey(identity: TradingBotRuntimeIdentity): string {
    return `${identity.botKind}:${identity.chainId}:${identity.walletId}`;
}
