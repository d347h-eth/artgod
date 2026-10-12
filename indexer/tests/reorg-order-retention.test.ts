import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { ORDER_STATUS, ORDER_SOURCE_STATUS } from "../src/domain/orders.js";
import { ORDER_RETIREMENT_REASON } from "../src/domain/order-retention.js";
import { REORG_RECOVERY_PHASE } from "../src/domain/reorg-recovery.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { insertCollection } from "./helpers/ownership-fixture.js";
import {
    REORG_FIXTURE as F,
    RecoveryRpc,
    reorgRecoveryServices,
    seedRecoveryHistory,
    retainCanonicalCheckFixture,
} from "./helpers/reorg-recovery-fixture.js";

describe("verified rollback preserves market evidence outside its range", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    it.each([false, true])(
        "invalidates only attributed orphan evidence and commits atomically (failure=%s)",
        async (failCommit) => {
            const s = reorgRecoveryServices(new RecoveryRpc());
            const f = seedRecoveryHistory();
            const otherCollection = insertCollection({
                chainId: 2,
                slug: "other-chain",
                address: F.Owner,
                anchorBlock: F.Anchor,
            });
            // Deliberately exercise storage attribution, including absent evidence.
            const positions = [
                { name: "before", block: 90, affected: false },
                { name: "fork", block: F.Fork, affected: false },
                { name: "boundary", block: F.Orphan, affected: true },
                { name: "after", block: F.Orphan + 1, affected: true },
                { name: "unknown", block: null, affected: false },
            ];
            const states = [
                {
                    name: "filled",
                    source: ORDER_SOURCE_STATUS.Active,
                    status: ORDER_STATUS.Filled,
                    independent: false,
                },
                {
                    name: "cancelled",
                    source: ORDER_SOURCE_STATUS.Active,
                    status: ORDER_STATUS.Cancelled,
                    independent: false,
                },
                {
                    name: "source-filled",
                    source: ORDER_SOURCE_STATUS.Filled,
                    status: ORDER_STATUS.Filled,
                    independent: false,
                },
                {
                    name: "source-cancelled",
                    source: ORDER_SOURCE_STATUS.Cancelled,
                    status: ORDER_STATUS.Cancelled,
                    independent: true,
                },
            ];
            const insertOrder = db.prepare(
                "INSERT INTO orders(id,chain_id,collection_id,kind,maker,contract_address,token_id,fillability_status,source_status,block_number) VALUES(?,?,?,'seaport',?,?,'9',?,?,?)",
            );
            const insertRetirement = db.prepare(
                "INSERT INTO market_order_retirements(chain_id,collection_id,order_id,reason,retired_at,expires_at,block_number) VALUES(?,?,?,?,?,?,?)",
            );
            const expires = Math.floor(Date.now() / 1000) + 3600;
            const retainedOrders = new Set<string>();
            const retainedMarkers = new Set<string>();
            for (const position of positions)
                for (const state of states) {
                    const id = `${state.name}:${position.name}`;
                    insertOrder.run(
                        id,
                        1,
                        f.collectionId,
                        F.Owner,
                        f.contract,
                        state.status,
                        state.source,
                        position.block,
                    );
                    insertRetirement.run(
                        1,
                        f.collectionId,
                        id,
                        state.independent
                            ? ORDER_RETIREMENT_REASON.SourceCancelled
                            : ORDER_RETIREMENT_REASON.Terminal,
                        expires - 3600,
                        expires,
                        position.block,
                    );
                    if (!position.affected || state.independent) {
                        retainedOrders.add(id);
                        retainedMarkers.add(id);
                    }
                }
            insertOrder.run(
                "other-chain",
                2,
                otherCollection,
                F.Owner,
                F.Owner,
                ORDER_STATUS.Filled,
                ORDER_SOURCE_STATUS.Active,
                F.Orphan,
            );
            insertRetirement.run(
                2,
                otherCollection,
                "other-chain",
                ORDER_RETIREMENT_REASON.Terminal,
                expires - 3600,
                expires,
                F.Orphan,
            );
            retainedOrders.add("other-chain");
            retainedMarkers.add("other-chain");
            for (const reason of [
                ORDER_RETIREMENT_REASON.Expired,
                ORDER_RETIREMENT_REASON.Stale,
            ]) {
                const id = `independent:${reason}`;
                insertRetirement.run(
                    1,
                    f.collectionId,
                    id,
                    reason,
                    expires - 3600,
                    expires,
                    F.Orphan,
                );
                retainedMarkers.add(id);
            }
            const orders = () =>
                db.prepare("SELECT * FROM orders ORDER BY id").all() as {
                    id: string;
                }[];
            const markers = () =>
                db
                    .prepare(
                        "SELECT * FROM market_order_retirements ORDER BY order_id",
                    )
                    .all() as { order_id: string }[];
            const beforeOrders = orders(),
                beforeMarkers = markers();
            if (failCommit)
                db.exec(
                    `CREATE TEMP TRIGGER fail_retained_resync BEFORE UPDATE ON chain_reorg_recoveries WHEN NEW.phase='${REORG_RECOVERY_PHASE.Resync}' BEGIN SELECT RAISE(ABORT,'resync unavailable'); END;`,
                );
            retainCanonicalCheckFixture(s.storage, F.Orphan);
            expect(await s.recovery.checkDue()).toBe(true);
            if (failCommit) {
                expect(orders()).toEqual(beforeOrders);
                expect(markers()).toEqual(beforeMarkers);
                expect(s.storage.captureSyncCheckpoint(1).revision).toBe(0);
                expect(s.recoveries.getRecovery(1)?.phase).toBe(
                    REORG_RECOVERY_PHASE.AwaitingAncestor,
                );
            } else {
                expect(orders()).toEqual(
                    beforeOrders.filter((row) => retainedOrders.has(row.id)),
                );
                expect(markers()).toEqual(
                    beforeMarkers.filter((row) =>
                        retainedMarkers.has(row.order_id),
                    ),
                );
                expect(s.storage.captureSyncCheckpoint(1).revision).toBe(1);
                expect(s.recoveries.getRecovery(1)?.phase).toBe(
                    REORG_RECOVERY_PHASE.Resync,
                );
            }
        },
    );
});
