import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { usableOrderEvidenceSql } from "@artgod/shared/database/order-evidence";
import { RetainCanonicalOrderEffects } from "../src/application/orders/retain-canonical-order-effects.js";
import {
    MAKER_REVALIDATION_POLICY,
    MAKER_REVALIDATION_STATUS as STATUS,
    MakerRevalidationConflict,
    makerValidationScopeKey,
} from "../src/domain/maker-revalidation.js";
import { GLOBAL_MAKER_TRIGGER_REASON } from "../src/domain/maker-triggers.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteMakerRevalidations } from "../src/infra/orders/sqlite-maker-revalidations.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { createAppliedSyncFixture } from "./helpers/applied-sync-fixture.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import {
    emptyOnChainData,
    loadCollection,
    transferFixture,
} from "./helpers/ownership-fixture.js";
import { commitRollbackFixture } from "./helpers/rollback-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const MAKER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WETH = "0xcccccccccccccccccccccccccccccccccccccccc";
const NOW = Date.now();

loadTestEnv();
describe("pending canonical maker obligations across rollback", () => {
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    afterEach(() => db.raw.close());

    function fixture(orderCount = 1) {
        const f = transferFixture();
        const insert = db.prepare(
            "INSERT INTO orders(id,chain_id,collection_id,kind,side,maker,contract_address,currency,quantity,fillable_quantity,source_status,fillability_status,validation_ready,proof_block_number,proof_block_hash,proof_chain_revision,proof_order_revision,proof_admission_sequence,proof_at) VALUES (?,1,?,'seaport','buy',?,?,?,'1','1','active','fillable',1,100,?,0,0,0,?)",
        );
        for (let i = 0; i < orderCount; i++)
            insert.run(
                orderId(i),
                f.collectionId,
                MAKER,
                f.contract,
                WETH,
                block(100).hash,
                NOW,
            );
        const orders = new SqliteOrdersDomain(WETH);
        const demand = new SqliteOrderValidationDemand(orders);
        const makers = new SqliteMakerRevalidations(orders, demand, WETH);
        const owner = createAppliedSyncFixture({
            chainId: 1,
            anchor: block(100),
            collections: [loadCollection(1, f.collectionId)],
            orderEffects: new RetainCanonicalOrderEffects({ orders, makers }),
            now: () => NOW,
        });
        function apply(height: number, event = true) {
            const data = emptyOnChainData();
            if (event)
                data.global.makerTriggers.push({
                    maker: MAKER,
                    reason: GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
                    blockNumber: height,
                    blockHash: block(height).hash,
                    txHash: block(height).hash,
                    logIndex: 0,
                });
            const tip = owner.progress.chainProgress(1)!.applied.number;
            owner.commit(
                owner.applied({
                    blocks: Array.from({ length: height - tip }, (_, i) =>
                        block(tip + i + 1),
                    ),
                    data,
                    shared: true,
                    collectionIds: [f.collectionId],
                }),
            );
        }
        function run() {
            const row = db
                .prepare(
                    "SELECT run_id AS runId FROM maker_order_revalidation_runs",
                )
                .get() as { runId: string };
            return makers.get(row.runId)!;
        }
        const rollback = (fromBlock: number) =>
            commitRollbackFixture({
                storage: owner.storage,
                chainId: 1,
                fromBlock,
                owners: [],
            });
        const expand = () =>
            makers.expand(makers.claim(run().runId, "worker", NOW)!, NOW);
        return { ...owner, makers, demand, apply, run, rollback, expand };
    }

    it("keeps proof100 unusable until the surviving unexpanded invalidation101 is handed to demand", () => {
        const f = fixture();
        expect(usable()).toBe(true);
        f.apply(101);
        f.apply(102, false);
        expect(usable()).toBe(false);
        expect(f.demand.get(1, orderId(0))).toBeNull();
        f.rollback(102);
        expect(usable()).toBe(false);
        expect(f.run()).toMatchObject({
            status: STATUS.Pending,
            chainRevision: 1,
        });
        expect(f.expand().status).toBe(STATUS.Completed);
        expect(f.demand.get(1, orderId(0))).toMatchObject({
            pending: true,
            minimumBlock: 101,
            minimumBlockHash: block(101).hash,
        });
        expect(usable()).toBe(false);
    });

    it("trims an orphan requested pass while preserving the unfinished cursor, boundary, identity and receipts", () => {
        const f = fixture(MAKER_REVALIDATION_POLICY.batchOrders + 1);
        f.apply(101);
        f.expand();
        f.apply(102);
        const before = f.run();
        expect(before.afterId).toBe(
            orderId(MAKER_REVALIDATION_POLICY.batchOrders - 1),
        );
        expect(before.generation).toBeGreaterThan(before.passGeneration);
        db.prepare(
            "INSERT INTO maker_validation_delivery_origins(run_id,consumer_name,stream_id,maximum_sequence) VALUES (?,'fixture','stream',7)",
        ).run(before.runId);
        const source = db
            .prepare(
                "SELECT source_payload_json AS payload FROM maker_order_revalidation_runs",
            )
            .get();
        f.rollback(102);
        const after = f.run();
        expect(after).toMatchObject({
            runId: before.runId,
            sourceJobId: before.sourceJobId,
            afterId: before.afterId,
            upperOrderId: before.upperOrderId,
            upperRowId: before.upperRowId,
            step: before.step,
            wakeupOutboxId: before.wakeupOutboxId,
            payload: before.payload,
            requestedPayload: before.payload,
            chainRevision: 1,
            passGeneration: before.generation,
        });
        expect(
            db
                .prepare(
                    "SELECT source_payload_json AS payload FROM maker_order_revalidation_runs",
                )
                .get(),
        ).toEqual(source);
        expect(
            db
                .prepare(
                    "SELECT maximum_sequence AS sequence FROM maker_validation_delivery_origins WHERE run_id=?",
                )
                .get(after.runId),
        ).toEqual({ sequence: 7 });
        expect(usable(orderId(MAKER_REVALIDATION_POLICY.batchOrders))).toBe(
            false,
        );
        expect(f.expand().status).toBe(STATUS.Completed);
        expect(
            f.demand.get(1, orderId(MAKER_REVALIDATION_POLICY.batchOrders)),
        ).toMatchObject({ minimumBlock: 101, pending: true });
    });

    it("retains both surviving requirements and coalesces a new event into the rebound scope", () => {
        const f = fixture();
        f.apply(101);
        f.apply(102);
        f.apply(103, false);
        const before = f.run();
        f.rollback(103);
        expect(f.run()).toMatchObject({
            payload: before.payload,
            requestedPayload: before.requestedPayload,
            generation: before.generation,
            passGeneration: before.passGeneration,
            scopeKey: makerValidationScopeKey(before.payload, 1),
        });
        f.apply(103);
        expect(count("maker_order_revalidation_runs")).toBe(1);
        expect(f.run().runId).toBe(before.runId);
        expect(f.run().requestedPayload.blockNumber).toBe(103);
        expect(f.expand()).toMatchObject({
            status: STATUS.Pending,
            payload: { blockNumber: 103 },
        });
        expect(f.expand().status).toBe(STATUS.Completed);
        expect(f.demand.get(1, orderId(0))).toMatchObject({
            minimumBlock: 103,
            pending: true,
        });
    });

    it("caps an entirely orphaned scope at the ancestor without reopening the old expansion", () => {
        const f = fixture();
        f.apply(101);
        const claim = f.makers.claim(f.run().runId, "captured", NOW)!;
        f.rollback(101);
        expect(f.run()).toMatchObject({
            status: STATUS.Pending,
            payload: {
                blockNumber: 100,
                blockHash: block(100).hash,
                txHash: null,
                logIndex: null,
            },
        });
        expect(count("queue_outbox")).toBe(1);
        expect(usable()).toBe(true);
        expect(() => f.makers.expand(claim, NOW)).toThrow(
            MakerRevalidationConflict,
        );
        expect(f.expand().status).toBe(STATUS.Completed);
        expect(count("queue_outbox")).toBe(0);
        expect(f.demand.get(1, orderId(0))).toBeNull();
    });

    it("retains a coalesced surviving intermediate event when only the requested maximum is orphaned", () => {
        const f = fixture();
        f.apply(101);
        f.apply(102);
        f.apply(103);
        db.prepare(
            "UPDATE orders SET proof_block_number=101,proof_block_hash=?",
        ).run(block(101).hash);
        f.rollback(103);
        expect(f.run()).toMatchObject({
            payload: { blockNumber: 101 },
            requestedPayload: {
                blockNumber: 102,
                blockHash: block(102).hash,
                txHash: null,
                logIndex: null,
            },
        });
        expect(usable()).toBe(false);
        expect(f.expand()).toMatchObject({
            status: STATUS.Pending,
            payload: { blockNumber: 102 },
        });
        expect(usable()).toBe(false);
        expect(f.expand().status).toBe(STATUS.Completed);
        expect(f.demand.get(1, orderId(0))).toMatchObject({
            minimumBlock: 102,
            pending: true,
        });
    });

    it("caps an orphaned promoted pass without losing coalesced surviving work or its partial cursor", () => {
        const f = fixture(MAKER_REVALIDATION_POLICY.batchOrders + 1);
        f.apply(101);
        f.apply(102);
        f.apply(103);
        f.expand();
        expect(f.expand()).toMatchObject({
            payload: { blockNumber: 103 },
            afterId: "",
        });
        // The first generation was validated at101 before the next expansion.
        db.prepare(
            "UPDATE orders SET proof_block_number=101,proof_block_hash=?",
        ).run(block(101).hash);
        db.exec("UPDATE order_validation_demand SET pending=0");
        f.expand();
        const before = f.run();
        expect(before.afterId).toBe(
            orderId(MAKER_REVALIDATION_POLICY.batchOrders - 1),
        );
        f.rollback(103);
        expect(f.run()).toMatchObject({
            afterId: before.afterId,
            upperOrderId: before.upperOrderId,
            upperRowId: before.upperRowId,
            payload: {
                blockNumber: 102,
                blockHash: block(102).hash,
                txHash: null,
                logIndex: null,
            },
            requestedPayload: { blockNumber: 102 },
            passGeneration: before.generation,
        });
        expect(usable(orderId(MAKER_REVALIDATION_POLICY.batchOrders))).toBe(
            false,
        );
        expect(f.demand.get(1, orderId(0))).toMatchObject({
            pending: true,
            minimumBlock: null,
        });
        expect(f.expand().status).toBe(STATUS.Completed);
        expect(
            f.demand.get(1, orderId(MAKER_REVALIDATION_POLICY.batchOrders)),
        ).toMatchObject({ minimumBlock: 102, pending: true });
    });

    it("fences captured leases and preserves the same obligation through repeated rollback", () => {
        const f = fixture();
        f.apply(101);
        f.apply(103, false);
        const claim = f.makers.claim(f.run().runId, "captured", NOW)!;
        f.rollback(103);
        expect(() => f.makers.expand(claim, NOW)).toThrow(
            MakerRevalidationConflict,
        );
        f.rollback(102);
        expect(f.run()).toMatchObject({
            runId: claim.runId,
            chainRevision: 2,
            scopeKey: makerValidationScopeKey(claim.payload, 2),
            status: STATUS.Pending,
            leaseOwner: null,
        });
        expect(usable()).toBe(false);
        expect(f.expand().status).toBe(STATUS.Completed);
        expect(f.demand.get(1, orderId(0))?.minimumBlock).toBe(101);
    });

    it("does not rebind a requirement whose retained header has a different hash", () => {
        const f = fixture();
        f.apply(101);
        f.apply(102, false);
        // Exact hash matching is independent of height; simulate a retained
        // fork header that cannot certify the scope's recorded event identity.
        db.prepare(
            "UPDATE blocks SET block_hash=? WHERE chain_id=1 AND block_number=101",
        ).run(block(201).hash);
        f.rollback(102);
        expect(f.run()).toMatchObject({
            status: STATUS.Pending,
            payload: {
                blockNumber: 101,
                blockHash: block(201).hash,
                txHash: null,
                logIndex: null,
            },
        });
        expect(f.expand().status).toBe(STATUS.Completed);
        expect(f.demand.get(1, orderId(0))).toMatchObject({
            minimumBlock: 101,
            minimumBlockHash: block(201).hash,
            pending: true,
        });
        expect(count("queue_outbox")).toBe(0);
    });

    it("rolls back revision, headers, scope and proof changes when obligation reconciliation fails", () => {
        const f = fixture();
        f.apply(101);
        f.apply(102, false);
        const before = f.run();
        db.exec(
            "CREATE TEMP TRIGGER fail_scope_rebind BEFORE UPDATE OF required_chain_revision ON maker_order_revalidation_runs BEGIN SELECT RAISE(ABORT,'scope rebind failed'); END;",
        );
        expect(() => f.rollback(102)).toThrow("scope rebind failed");
        expect(f.storage.captureSyncCheckpoint(1).revision).toBe(0);
        expect(f.progress.chainProgress(1)?.applied.number).toBe(102);
        expect(f.storage.getBlockHash(1, 102)).toBe(block(102).hash);
        expect(f.run()).toEqual(before);
        expect(count("queue_outbox")).toBe(1);
        expect(usable()).toBe(false);
        db.exec("DROP TRIGGER fail_scope_rebind");
    });
});

function orderId(index: number) {
    return `bid-${String(index).padStart(4, "0")}`;
}
function count(table: string): number {
    return (
        db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
    ).n;
}
function usable(id = orderId(0)): boolean {
    return !!(
        db
            .prepare(
                `SELECT ${usableOrderEvidenceSql({ orderAlias: "o", nowMs: String(NOW) })} AS usable FROM orders o WHERE id=?`,
            )
            .get(id) as { usable: number }
    ).usable;
}
