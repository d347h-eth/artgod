import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { FILL_KIND } from "@artgod/shared/market-data/fills";
import { ORDER_STATUS, ORDER_SOURCE_STATUS } from "../src/domain/orders.js";
import { OFFCHAIN_ORDER_SOURCE } from "../src/domain/offchain-jobs.js";
import { ORDER_RETIREMENT_REASON } from "../src/domain/order-retention.js";
import { REORG_RECOVERY_PHASE } from "../src/domain/reorg-recovery.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { insertCollection } from "./helpers/ownership-fixture.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import { heavyMakerOrder } from "./fixtures/heavy-maker.js";
import {
    REORG_FIXTURE as F,
    RecoveryRpc,
    reorgRecoveryServices,
    seedRecoveryHistory,
    retainCanonicalCheckFixture,
} from "./helpers/reorg-recovery-fixture.js";

type RetainedOrder = {
    id: string;
    chain_id: number;
    kind: string;
    source_status: string;
    fillability_status: string;
    quantity: string | null;
    original_quantity: string | null;
    fillable_quantity: string | null;
    seaport_data_json: string | null;
    validation_ready: number;
    state_revision: number;
    block_number: number | null;
    proof_block_number: number | null;
};

describe("verified rollback preserves declarations and source observations", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    it.each([false, true])(
        "invalidates only orphan state and proof atomically (failure=%s)",
        async (failCommit) => {
            const s = reorgRecoveryServices(new RecoveryRpc());
            const f = seedRecoveryHistory();
            const otherCollection = insertCollection({
                chainId: 2,
                slug: "other-chain",
                address: F.Owner,
                anchorBlock: F.Anchor,
            });
            const expires = Math.floor(Date.now() / 1000) + 3600;
            const positions = [90, F.Fork, F.Orphan, F.Orphan + 1, null];
            const states = [
                {
                    status: ORDER_STATUS.Filled,
                    source: ORDER_SOURCE_STATUS.Active,
                },
                {
                    status: ORDER_STATUS.Cancelled,
                    source: ORDER_SOURCE_STATUS.Active,
                },
                {
                    status: ORDER_STATUS.Fillable,
                    source: ORDER_SOURCE_STATUS.Active,
                },
                {
                    status: ORDER_STATUS.Filled,
                    source: ORDER_SOURCE_STATUS.Inactive,
                },
            ];
            const insertOrder = db.prepare(
                "INSERT INTO orders(id,chain_id,collection_id,kind,maker,contract_address,token_id,fillability_status,source_status,block_number,block_hash,proof_block_number,proof_block_hash,proof_chain_revision,proof_order_revision,proof_at,quantity,original_quantity,fillable_quantity,seaport_data_json,validation_ready,valid_until) VALUES(?,?,?,?,?,?,'9',?,?,?,?,?,?,0,0,?, '0',?, '0',?,?,?)",
            );
            const insertSource = db.prepare(
                "INSERT INTO order_source_observations(chain_id,collection_id,order_id,source_id,source_status,observation_key,declared_quantity,source_observed_at,admitted_at,expires_at) VALUES(?,?,?,?,?,?,?, ?,?,?)",
            );
            const terms = JSON.stringify(heavyMakerOrder(0).seaportData);
            // Storage invalidation does not depend on supported validation kind
            // or complete terms. Neither fact turns a declaration into chain data.
            for (const kind of [FILL_KIND.Seaport, FILL_KIND.Wyvern])
                for (const complete of [false, true])
                    for (const block of positions)
                        for (const state of states) {
                            const id = `${kind}:${complete}:${block}:${state.status}:${state.source}`;
                            insertOrder.run(
                                id,
                                1,
                                f.collectionId,
                                kind,
                                F.Owner,
                                f.contract,
                                state.status,
                                state.source,
                                block,
                                block === null
                                    ? null
                                    : syncBlockFixture(block).hash,
                                block,
                                block === null
                                    ? null
                                    : syncBlockFixture(block).hash,
                                expires - 3600,
                                complete ? "1" : null,
                                complete ? terms : null,
                                complete && kind === FILL_KIND.Seaport ? 1 : 0,
                                expires,
                            );
                            insertSource.run(
                                1,
                                f.collectionId,
                                id,
                                OFFCHAIN_ORDER_SOURCE.OpenSea,
                                ORDER_SOURCE_STATUS.Cancelled,
                                `withdrawal:${id}`,
                                "1",
                                expires - 3600,
                                (expires - 3600) * 1000,
                                expires * 1000,
                            );
                            insertSource.run(
                                1,
                                f.collectionId,
                                id,
                                "fixture-peer",
                                state.source === ORDER_SOURCE_STATUS.Active
                                    ? ORDER_SOURCE_STATUS.Active
                                    : ORDER_SOURCE_STATUS.Inactive,
                                `peer:${id}`,
                                "1",
                                expires - 3600,
                                (expires - 3600) * 1000,
                                expires * 1000,
                            );
                        }
            insertOrder.run(
                "other-chain",
                2,
                otherCollection,
                FILL_KIND.Seaport,
                F.Owner,
                F.Owner,
                ORDER_STATUS.Filled,
                ORDER_SOURCE_STATUS.Active,
                F.Orphan,
                syncBlockFixture(F.Orphan).hash,
                F.Orphan,
                syncBlockFixture(F.Orphan).hash,
                expires - 3600,
                "1",
                terms,
                1,
                expires,
            );
            // Current cleanup retains unexpired canonical terminals. Expiry and
            // source-inactivity markers carry independent reasons to remain gone.
            for (const reason of [
                ORDER_RETIREMENT_REASON.Expired,
                ORDER_RETIREMENT_REASON.Stale,
            ])
                db.prepare(
                    "INSERT INTO market_order_retirements(chain_id,collection_id,order_id,reason,retired_at,expires_at,block_number) VALUES(?,?,?,?,?,?,?)",
                ).run(
                    1,
                    f.collectionId,
                    `retired:${reason}`,
                    reason,
                    expires - 3600,
                    expires,
                    F.Orphan,
                );
            const orders = () =>
                db
                    .prepare("SELECT * FROM orders ORDER BY id")
                    .all() as RetainedOrder[];
            const sources = () =>
                db
                    .prepare(
                        "SELECT * FROM order_source_observations ORDER BY chain_id,order_id,source_id",
                    )
                    .all();
            const markers = () =>
                db
                    .prepare(
                        "SELECT * FROM market_order_retirements ORDER BY order_id",
                    )
                    .all();
            const demands = () =>
                db
                    .prepare(
                        "SELECT order_id,pending FROM order_validation_demand ORDER BY order_id",
                    )
                    .all();
            const beforeOrders = orders(),
                beforeSources = sources(),
                beforeMarkers = markers(),
                beforeDemands = demands();
            if (failCommit)
                db.exec(
                    `CREATE TEMP TRIGGER fail_retained_resync BEFORE UPDATE ON chain_reorg_recoveries WHEN NEW.phase='${REORG_RECOVERY_PHASE.Resync}' BEGIN SELECT RAISE(ABORT,'resync unavailable'); END;`,
                );
            retainCanonicalCheckFixture(s.storage, F.Orphan);
            expect(await s.recovery.checkDue()).toBe(true);
            expect(sources()).toEqual(beforeSources);
            expect(markers()).toEqual(beforeMarkers);
            if (failCommit) {
                expect(orders()).toEqual(beforeOrders);
                expect(demands()).toEqual(beforeDemands);
                expect(s.storage.captureSyncCheckpoint(1).revision).toBe(0);
                expect(s.recoveries.getRecovery(1)?.phase).toBe(
                    REORG_RECOVERY_PHASE.AwaitingAncestor,
                );
                return;
            }
            const afterOrders = orders();
            expect(afterOrders.map((row) => row.id)).toEqual(
                beforeOrders.map((row) => row.id),
            );
            const expectedPending = [];
            for (const before of beforeOrders) {
                const after = afterOrders.find((row) => row.id === before.id)!;
                const orphaned =
                    before.chain_id === 1 &&
                    before.block_number !== null &&
                    before.block_number >= F.Orphan;
                if (!orphaned) {
                    // Surviving exact proofs may be rebound to the new revision;
                    // declaration, lifecycle result and quantities stay unchanged.
                    expect(after).toMatchObject({
                        id: before.id,
                        source_status: before.source_status,
                        block_number: before.block_number,
                        quantity: before.quantity,
                        fillability_status: before.fillability_status,
                        proof_block_number: before.proof_block_number,
                        state_revision: before.state_revision,
                    });
                    continue;
                }
                expect(after).toMatchObject({
                    id: before.id,
                    kind: before.kind,
                    source_status: before.source_status,
                    original_quantity: before.original_quantity,
                    seaport_data_json: before.seaport_data_json,
                    validation_ready: before.validation_ready,
                    fillability_status: ORDER_STATUS.Unvalidated,
                    quantity: null,
                    fillable_quantity: null,
                    block_number: null,
                    proof_block_number: null,
                    state_revision: before.state_revision + 1,
                });
                if (
                    before.kind === FILL_KIND.Seaport &&
                    before.source_status === ORDER_SOURCE_STATUS.Active
                )
                    expectedPending.push({ order_id: before.id, pending: 1 });
            }
            expect(demands()).toEqual(
                expectedPending.sort((a, b) =>
                    a.order_id.localeCompare(b.order_id),
                ),
            );
            expect(s.storage.captureSyncCheckpoint(1).revision).toBe(1);
            expect(s.recoveries.getRecovery(1)?.phase).toBe(
                REORG_RECOVERY_PHASE.Resync,
            );
        },
    );
});
