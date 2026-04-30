import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    TRADING_BOT_KIND,
    TRADING_BOT_RUNTIME_STATE,
} from "@artgod/shared/types";
import { SqliteTradingBotRuntimeState } from "./sqlite-trading-bot-runtime-state.js";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-bot-runtime-state-"));
    return join(dir, "main.sqlite");
}

describe("SqliteTradingBotRuntimeState", () => {
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        const migrationRunner = createMigrationRunner();
        await migrationRunner.runMigrations();
    });

    it("publishes running heartbeats and terminal lifecycle states", () => {
        const state = new SqliteTradingBotRuntimeState(60_000);
        const identity = {
            botKind: TRADING_BOT_KIND.Bidding,
            chainId: 1,
            walletId: "wallet-1",
            address: "0x1111111111111111111111111111111111111111",
        };

        // Publish the running heartbeat that backend bid-book source selection consumes.
        state.startHeartbeat(identity, TRADING_BOT_RUNTIME_STATE.Running);
        state.stopHeartbeat();
        state.markState(identity, TRADING_BOT_RUNTIME_STATE.Stopped);

        const row = db
            .prepare<[string, number, string]>(
                "SELECT bot_kind, chain_id, wallet_id, address, state, heartbeat_at, started_at, updated_at, last_error " +
                    "FROM trading_bot_runtime_state " +
                    "WHERE bot_kind = ? AND chain_id = ? AND wallet_id = ?",
            )
            .get(identity.botKind, identity.chainId, identity.walletId) as
            | {
                  bot_kind: string;
                  chain_id: number;
                  wallet_id: string;
                  address: string;
                  state: string;
                  heartbeat_at: string;
                  started_at: string;
                  updated_at: string;
                  last_error: string | null;
              }
            | undefined;

        assert.ok(row);
        assert.equal(row.bot_kind, TRADING_BOT_KIND.Bidding);
        assert.equal(row.chain_id, 1);
        assert.equal(row.wallet_id, "wallet-1");
        assert.equal(row.address, identity.address);
        assert.equal(row.state, TRADING_BOT_RUNTIME_STATE.Stopped);
        assert.ok(Date.parse(row.heartbeat_at) > 0);
        assert.ok(Date.parse(row.started_at) > 0);
        assert.ok(Date.parse(row.updated_at) > 0);
        assert.equal(row.last_error, null);
    });
});
