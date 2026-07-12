import { randomUUID } from "node:crypto";
import { db } from "@artgod/shared/database";
import type { BetterSqlite3NamedStatement } from "@artgod/shared/database";
import { TRADING_BOT_RUNTIME_HEARTBEAT_INTERVAL_MS } from "@artgod/shared/trading/runtime-state";
import {
    TRADING_BOT_KIND,
    type TradingBotRuntimeState,
} from "@artgod/shared/types";
import type { BiddingMandateSnapshot } from "../../domain/bidding-mandate.js";

export type BiddingBotRuntimeIdentity = {
    botKind: typeof TRADING_BOT_KIND.Bidding;
    chainId: number;
    walletId: string;
    address: string;
};

type ActiveBiddingRuntimeSession = {
    identity: BiddingBotRuntimeIdentity;
    sessionId: string;
    startedAt: string;
};

type UpsertRuntimeStateParams = BiddingBotRuntimeIdentity & {
    sessionId: string;
    state: TradingBotRuntimeState;
    heartbeatAt: string;
    startedAt: string;
    updatedAt: string;
    lastError: string | null;
};

type DeleteAuthorizedCollectionsParams = {
    chainId: number;
    walletId: string;
};

type InsertAuthorizedCollectionParams = DeleteAuthorizedCollectionsParams & {
    sessionId: string;
    collectionId: number;
    contractAddress: string;
    openseaSlug: string;
    maxUnitBidWei: string;
    maxQuantity: number;
    publishedAt: string;
};

// Publishes one immutable bidding authorization beside the lifecycle heartbeat for that exact process session.
export class SqliteBiddingBotRuntimeState {
    private readonly upsertRuntimeState: BetterSqlite3NamedStatement<UpsertRuntimeStateParams>;
    private readonly deleteAuthorizedCollections: BetterSqlite3NamedStatement<DeleteAuthorizedCollectionsParams>;
    private readonly insertAuthorizedCollection: BetterSqlite3NamedStatement<InsertAuthorizedCollectionParams>;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private activeSession: ActiveBiddingRuntimeSession | null = null;

    constructor(
        private readonly mandate: BiddingMandateSnapshot,
        private readonly heartbeatIntervalMs: number = TRADING_BOT_RUNTIME_HEARTBEAT_INTERVAL_MS,
    ) {
        this.upsertRuntimeState = db.prepare<UpsertRuntimeStateParams>(
            "INSERT INTO trading_bot_runtime_state " +
                "(bot_kind, chain_id, wallet_id, address, runtime_session_id, state, heartbeat_at, started_at, updated_at, last_error) " +
                "VALUES (@botKind, @chainId, @walletId, @address, @sessionId, @state, @heartbeatAt, @startedAt, @updatedAt, @lastError) " +
                "ON CONFLICT(bot_kind, chain_id, wallet_id) DO UPDATE SET " +
                "address = excluded.address, " +
                "runtime_session_id = excluded.runtime_session_id, " +
                "state = excluded.state, " +
                "heartbeat_at = excluded.heartbeat_at, " +
                "started_at = excluded.started_at, " +
                "updated_at = excluded.updated_at, " +
                "last_error = excluded.last_error",
        ) as BetterSqlite3NamedStatement<UpsertRuntimeStateParams>;
        this.deleteAuthorizedCollections =
            db.prepare<DeleteAuthorizedCollectionsParams>(
                "DELETE FROM trading_bidding_runtime_authorized_collections " +
                    "WHERE chain_id = @chainId AND wallet_id = @walletId",
            ) as BetterSqlite3NamedStatement<DeleteAuthorizedCollectionsParams>;
        this.insertAuthorizedCollection =
            db.prepare<InsertAuthorizedCollectionParams>(
                "INSERT INTO trading_bidding_runtime_authorized_collections " +
                    "(runtime_session_id, chain_id, wallet_id, collection_id, contract_address, opensea_slug, max_unit_bid_wei, max_quantity, published_at) " +
                    "VALUES (@sessionId, @chainId, @walletId, @collectionId, @contractAddress, @openseaSlug, @maxUnitBidWei, @maxQuantity, @publishedAt)",
            ) as BetterSqlite3NamedStatement<InsertAuthorizedCollectionParams>;
    }

    // Starts or transitions the heartbeat without changing the immutable authorization for this process session.
    startHeartbeat(
        identity: BiddingBotRuntimeIdentity,
        state: TradingBotRuntimeState,
    ): void {
        this.stopHeartbeat();
        const activeSession = this.resolveActiveSession(identity);
        if (this.activeSession !== activeSession) {
            this.publishNewSession(activeSession, state);
            this.activeSession = activeSession;
        } else {
            this.writeState(activeSession, state, null);
        }
        this.heartbeatTimer = setInterval(() => {
            this.writeState(activeSession, state, null);
        }, this.heartbeatIntervalMs);
        this.heartbeatTimer.unref?.();
    }

    // Writes an immediate one-shot lifecycle transition for backend readers.
    markState(
        identity: BiddingBotRuntimeIdentity,
        state: TradingBotRuntimeState,
        lastError: string | null = null,
    ): void {
        const activeSession = this.resolveActiveSession(identity);
        if (this.activeSession !== activeSession) {
            this.publishNewSession(activeSession, state, lastError);
            this.activeSession = activeSession;
            return;
        }
        this.writeState(activeSession, state, lastError);
    }

    // Prevents stale timer writes after the supervised bot is shutting down.
    stopHeartbeat(): void {
        if (!this.heartbeatTimer) {
            return;
        }
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }

    private resolveActiveSession(
        identity: BiddingBotRuntimeIdentity,
    ): ActiveBiddingRuntimeSession {
        if (
            this.activeSession &&
            runtimeIdentityKey(this.activeSession.identity) ===
                runtimeIdentityKey(identity)
        ) {
            return this.activeSession;
        }
        if (identity.chainId !== this.mandate.chainId) {
            throw new Error(
                `Bidding runtime chain ${identity.chainId} does not match authorization chain ${this.mandate.chainId}`,
            );
        }
        return {
            identity,
            sessionId: randomUUID(),
            startedAt: new Date().toISOString(),
        };
    }

    private publishNewSession(
        session: ActiveBiddingRuntimeSession,
        state: TradingBotRuntimeState,
        lastError: string | null = null,
    ): void {
        const publishedAt = new Date().toISOString();
        // Replace the prior session projection and heartbeat together so readers never observe a partial authorization.
        db.raw.transaction(() => {
            this.deleteAuthorizedCollections.run({
                chainId: session.identity.chainId,
                walletId: session.identity.walletId,
            });
            for (const collection of this.mandate.collections) {
                this.insertAuthorizedCollection.run({
                    chainId: session.identity.chainId,
                    walletId: session.identity.walletId,
                    sessionId: session.sessionId,
                    collectionId: collection.collectionId,
                    contractAddress: collection.contractAddress,
                    openseaSlug: collection.openseaSlug,
                    maxUnitBidWei: collection.maxUnitBidWei,
                    maxQuantity: collection.maxQuantity,
                    publishedAt,
                });
            }
            this.writeState(session, state, lastError, publishedAt);
        })();
    }

    private writeState(
        session: ActiveBiddingRuntimeSession,
        state: TradingBotRuntimeState,
        lastError: string | null,
        now: string = new Date().toISOString(),
    ): void {
        // Persist the heartbeat so backend reads can bind authorization and feed state to this exact process session.
        this.upsertRuntimeState.run({
            ...session.identity,
            sessionId: session.sessionId,
            state,
            heartbeatAt: now,
            startedAt: session.startedAt,
            updatedAt: now,
            lastError,
        });
    }
}

function runtimeIdentityKey(identity: BiddingBotRuntimeIdentity): string {
    return `${identity.botKind}:${identity.chainId}:${identity.walletId}`;
}
