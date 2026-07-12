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
import type { BiddingMandateSnapshot } from "../../domain/bidding-mandate.js";
import { SqliteBiddingBotRuntimeState } from "./sqlite-bidding-bot-runtime-state.js";

const COLLECTION_ID = 1;
const COLLECTION_ADDRESS = "0x1111111111111111111111111111111111111111";
const OPENSEA_SLUG = "terraforms";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-bidding-runtime-state-"));
    return join(dir, "main.sqlite");
}

describe("SqliteBiddingBotRuntimeState", () => {
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        const migrationRunner = createMigrationRunner();
        await migrationRunner.runMigrations();
    });

    it("publishes one session-bound authorization with its lifecycle heartbeat", () => {
        const state = new SqliteBiddingBotRuntimeState(mandate(), 60_000);
        const identity = runtimeIdentity();

        state.startHeartbeat(identity, TRADING_BOT_RUNTIME_STATE.Bootstrapping);
        state.startHeartbeat(identity, TRADING_BOT_RUNTIME_STATE.Running);
        state.stopHeartbeat();
        state.markState(identity, TRADING_BOT_RUNTIME_STATE.Stopped);

        const runtimeRow = selectRuntimeRow(identity);
        assert.ok(runtimeRow);
        assert.equal(runtimeRow.state, TRADING_BOT_RUNTIME_STATE.Stopped);
        assert.ok(runtimeRow.runtime_session_id);
        assert.ok(Date.parse(runtimeRow.started_at) > 0);

        const authorizationRow = selectAuthorizationRow();
        assert.deepEqual(authorizationRow, {
            runtime_session_id: runtimeRow.runtime_session_id,
            chain_id: identity.chainId,
            wallet_id: identity.walletId,
            collection_id: COLLECTION_ID,
            contract_address: COLLECTION_ADDRESS,
            opensea_slug: OPENSEA_SLUG,
            max_unit_bid_wei: "200000000000000000",
            max_quantity: 1,
        });
    });

    it("replaces prior authorization rows when a new process session starts", () => {
        const identity = runtimeIdentity();
        const firstState = new SqliteBiddingBotRuntimeState(mandate(), 60_000);
        firstState.startHeartbeat(identity, TRADING_BOT_RUNTIME_STATE.Running);
        firstState.stopHeartbeat();
        const firstSessionId = selectRuntimeRow(identity)?.runtime_session_id;
        assert.ok(firstSessionId);

        const secondState = new SqliteBiddingBotRuntimeState(
            mandate("300000000000000000"),
            60_000,
        );
        secondState.startHeartbeat(identity, TRADING_BOT_RUNTIME_STATE.Running);
        secondState.stopHeartbeat();

        const runtimeRow = selectRuntimeRow(identity);
        const authorizationRows = db
            .prepare<
                []
            >("SELECT runtime_session_id, max_unit_bid_wei " + "FROM trading_bidding_runtime_authorized_collections")
            .all() as Array<{
            runtime_session_id: string;
            max_unit_bid_wei: string;
        }>;
        assert.ok(runtimeRow?.runtime_session_id);
        assert.notEqual(runtimeRow.runtime_session_id, firstSessionId);
        assert.deepEqual(authorizationRows, [
            {
                runtime_session_id: runtimeRow.runtime_session_id,
                max_unit_bid_wei: "300000000000000000",
            },
        ]);
    });
});

function runtimeIdentity() {
    return {
        botKind: TRADING_BOT_KIND.Bidding,
        chainId: 1,
        walletId: "wallet-1",
        address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    } as const;
}

function mandate(
    maxUnitBidWei: string = "200000000000000000",
): BiddingMandateSnapshot {
    return {
        chainId: 1,
        startPolicy: {
            wethAllowanceCapWei: "0",
            trustOpenSeaSignedZoneTraitOffers: false,
            wethApproval: {
                minPriorityFeePerGasWei: "1",
                maxFeePerGasWei: "2",
                maxTotalGasFeeWei: "3",
                pendingNoncePolicy: "fail",
            },
        },
        collections: [
            {
                collectionId: COLLECTION_ID,
                contractAddress: COLLECTION_ADDRESS,
                openseaSlug: OPENSEA_SLUG,
                maxUnitBidWei,
                maxQuantity: 1,
            },
        ],
    };
}

function selectRuntimeRow(identity: ReturnType<typeof runtimeIdentity>) {
    return db
        .prepare<
            [string, number, string]
        >("SELECT state, runtime_session_id, started_at " + "FROM trading_bot_runtime_state " + "WHERE bot_kind = ? AND chain_id = ? AND wallet_id = ?")
        .get(identity.botKind, identity.chainId, identity.walletId) as
        | {
              state: string;
              runtime_session_id: string | null;
              started_at: string;
          }
        | undefined;
}

function selectAuthorizationRow() {
    return db
        .prepare<
            []
        >("SELECT runtime_session_id, chain_id, wallet_id, collection_id, contract_address, opensea_slug, max_unit_bid_wei, max_quantity " + "FROM trading_bidding_runtime_authorized_collections")
        .get() as
        | {
              runtime_session_id: string;
              chain_id: number;
              wallet_id: string;
              collection_id: number;
              contract_address: string;
              opensea_slug: string;
              max_unit_bid_wei: string;
              max_quantity: number;
          }
        | undefined;
}
