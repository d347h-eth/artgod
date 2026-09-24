import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import {
    AdmitOrderValidation,
    ValidateOrderDemand,
} from "../src/application/orders/validate-order-demand.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import {
    ORDER_VALIDATION_DEMAND_OUTCOME as OUTCOME,
    ORDER_VALIDATION_DEMAND_POLICY as POLICY,
} from "../src/domain/order-validation-demand.js";
import {
    ORDER_SOURCE_STATUS,
    ORDER_SOURCE_SCOPE_KIND,
    ORDER_STATUS,
} from "../src/domain/orders.js";
import type { OrderUpsertPayload } from "../src/domain/order-jobs.js";
import {
    HEAVY_MAKER,
    HeavyMakerRpc,
    heavyMakerOrder,
    seedHeavyMaker,
    warmConduits,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const now = HEAVY_MAKER.now * 1_000;
const order = heavyMakerOrder(0);
const request = {
    chainId: order.chainId,
    orderId: order.id,
    requiredAt: now - 1_000,
    minimumBlock: HEAVY_MAKER.blockNumber,
};
const fillable = { status: ORDER_STATUS.Fillable, reason: "fixture" };
const proof = { observedAt: now, blockNumber: HEAVY_MAKER.blockNumber };

function workflow() {
    const rpc = new HeavyMakerRpc();
    const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth, async () => {
        throw new Error("Demand must use the strict injected snapshot");
    });
    const store = new SqliteOrderValidationDemand(domain);
    const processor = new ValidateOrderDemand({
        admission: new FairOrderValidationAdmission(2),
        chainId: HEAVY_MAKER.chainId,
        store,
        createSnapshot: createSeaportOrderValidationFactory({
            chainId: HEAVY_MAKER.chainId,
            rpc,
            conduits: warmConduits,
            conduitController: HEAVY_MAKER.controller,
        }),
    });
    return { rpc, domain, store, processor };
}

function upsert(): OrderUpsertPayload {
    return {
        chainId: order.chainId,
        collectionId: order.collectionId,
        orderId: order.id,
        kind: order.kind,
        side: "buy",
        maker: order.maker,
        contract: order.contract,
        tokenId: order.tokenId,
        sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
        price: order.price,
        currency: order.currency,
        validFrom: order.validFrom,
        validUntil: order.validUntil,
        source: "opensea",
        sourceStatus: ORDER_SOURCE_STATUS.Active,
        rawSourceKind: "rest",
        seaportData: order.seaportData,
        validateAfterUpsert: true,
        observedAt: HEAVY_MAKER.now,
    };
}

describe("durable ordinary validation demand", () => {
    loadTestEnv();
    let dbPath: string;
    beforeAll(async () => {
        dbPath = await createTempDbPath();
        setDbPath(dbPath);
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(now);
        for (const level of ["info", "warn", "error"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        db.exec("DELETE FROM orders; DELETE FROM collections;");
        seedHeavyMaker(1);
    });
    afterEach(() => vi.restoreAllMocks());

    it("coalesces old observation buckets into one current-revision validation and bounded storage", async () => {
        const work = workflow();
        for (let bucket = 0; bucket < 2_000; bucket++)
            work.store.admit(
                { ...request, requiredAt: now - (bucket + 1) * 300_000 },
                now,
            );
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM order_validation_demand",
                )
                .get(),
        ).toEqual({ count: 1 });
        await work.processor.executeNext();
        expect(work.rpc.reads.getOrderStatus).toBe(1);
        for (let bucket = 0; bucket < 2_000; bucket++)
            expect(
                work.store.admit(
                    { ...request, requiredAt: now - (bucket + 1) * 300_000 },
                    now,
                ),
            ).toBe(OUTCOME.Covered);
        expect(await work.processor.executeNext()).toBe(false);
        expect(work.store.get(request.chainId, request.orderId)).toMatchObject({
            pending: false,
            proofRevision: 0,
            proofAt: now,
            proofBlock: HEAVY_MAKER.blockNumber,
        });
    });

    it("does not use validated_at alone as proof for an unrecorded demand", async () => {
        db.prepare("UPDATE orders SET validated_at=? WHERE id=?").run(
            HEAVY_MAKER.now,
            order.id,
        );
        const work = workflow();
        expect(work.store.admit(request, now)).toBe(OUTCOME.Pending);
        await work.processor.executeNext();
        expect(work.rpc.reads.getOrderStatus).toBe(1);
    });

    it("records a validator's own resulting revision without scheduling itself forever", async () => {
        const work = workflow();
        work.rpc.balance = 0n;
        work.store.admit(request, now);
        await work.processor.executeNext();
        expect(work.store.get(request.chainId, request.orderId)).toMatchObject({
            pending: false,
            revision: 1,
            proofRevision: 1,
        });
        expect(work.store.admit(request, now)).toBe(OUTCOME.Covered);
        expect(await work.processor.executeNext()).toBe(false);
        expect(
            db
                .prepare("SELECT fillability_status FROM orders WHERE id=?")
                .get(order.id),
        ).toEqual({ fillability_status: ORDER_STATUS.NoBalance });
    });

    it("keeps newer trigger generations pending when they arrive during RPC", async () => {
        const work = workflow();
        work.store.admit(request, now);
        let triggered = false;
        work.rpc.onRead = () => {
            if (triggered) return;
            triggered = true;
            work.store.admit({ ...request, requiredAt: now }, now);
        };
        await work.processor.executeNext();
        expect(work.store.get(request.chainId, request.orderId)).toMatchObject({
            pending: true,
            generation: 2,
        });
        await work.processor.executeNext();
        expect(work.rpc.reads.getOrderStatus).toBe(2);
        expect(work.store.get(request.chainId, request.orderId)?.pending).toBe(
            false,
        );
    });

    it("rejects stale validation completion after a canonical change, even without another broker publish", async () => {
        const work = workflow();
        work.store.admit(request, now);
        let changed = false;
        work.rpc.onRead = () => {
            if (changed) return;
            changed = true;
            db.prepare(
                "UPDATE orders SET state_revision=state_revision+1,validated_at=0 WHERE id=?",
            ).run(order.id);
        };
        await work.processor.executeNext();
        expect(work.store.get(request.chainId, request.orderId)).toMatchObject({
            pending: true,
            proofRevision: null,
        });
        await work.processor.executeNext();
        expect(work.rpc.reads.getOrderStatus).toBe(2);
        expect(work.store.get(request.chainId, request.orderId)).toMatchObject({
            pending: false,
            proofRevision: 1,
        });
    });

    it("keeps a source cancellation that arrives during validation and performs no further RPC", async () => {
        const work = workflow();
        work.store.admit(request, now);
        work.rpc.onRead = async () => {
            work.rpc.onRead = undefined;
            await work.domain.handleOrderUpdateById({
                chainId: request.chainId,
                orderId: order.id,
                sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
                reason: "fixture-source-cancel",
                observedAt: HEAVY_MAKER.now + 1,
            });
        };
        await work.processor.executeNext();
        expect(await work.processor.executeNext()).toBe(false);
        expect(work.rpc.reads.getOrderStatus).toBe(1);
        expect(
            db
                .prepare("SELECT source_status FROM orders WHERE id=?")
                .get(order.id),
        ).toEqual({ source_status: ORDER_SOURCE_STATUS.Cancelled });
        expect(work.store.admit(request, now)).toBe(OUTCOME.Unneeded);
    });

    it("skips missing, expired, terminal and pre-anchor requests; deleting an order deletes its receipt", () => {
        const work = workflow();
        expect(work.store.admit({ ...request, orderId: "missing" }, now)).toBe(
            OUTCOME.Unneeded,
        );
        db.prepare("UPDATE orders SET valid_until=? WHERE id=?").run(
            HEAVY_MAKER.now,
            order.id,
        );
        expect(work.store.admit(request, now)).toBe(OUTCOME.Unneeded);
        db.prepare(
            "UPDATE orders SET valid_until=?,fillability_status=? WHERE id=?",
        ).run(HEAVY_MAKER.now + 100, ORDER_STATUS.Filled, order.id);
        expect(work.store.admit(request, now)).toBe(OUTCOME.Unneeded);
        db.prepare("UPDATE orders SET fillability_status=? WHERE id=?").run(
            ORDER_STATUS.Fillable,
            order.id,
        );
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=? WHERE collection_id=?",
        ).run(HEAVY_MAKER.blockNumber, order.collectionId);
        expect(
            work.store.admit(
                { ...request, minimumBlock: HEAVY_MAKER.blockNumber - 1 },
                now,
            ),
        ).toBe(OUTCOME.Unneeded);
        expect(
            work.store.admit(
                { ...request, minimumBlock: HEAVY_MAKER.blockNumber + 1 },
                now,
            ),
        ).toBe(OUTCOME.Pending);
        db.prepare("DELETE FROM orders WHERE id=?").run(order.id);
        expect(work.store.get(request.chainId, request.orderId)).toBe(null);
    });

    it("commits upsert and validation demand together without depending on a post-commit publication", async () => {
        const work = workflow();
        await work.domain.handleOrderUpsert(upsert());
        expect(work.store.get(request.chainId, request.orderId)?.pending).toBe(
            true,
        );
        db.raw.close();
        setDbPath(dbPath);
        const restarted = workflow();
        await restarted.processor.executeNext();
        expect(restarted.rpc.reads.getOrderStatus).toBe(1);
        expect(
            restarted.store.get(request.chainId, request.orderId)?.pending,
        ).toBe(false);
        await restarted.domain.handleOrderUpsert({
            ...upsert(),
            observedAt: HEAVY_MAKER.now - 1,
        });
        expect(await restarted.processor.executeNext()).toBe(false);
    });

    it("retries RPC failure durably without recording a protocol failure", async () => {
        const work = workflow();
        work.store.admit(request, now);
        work.rpc.onRead = () => {
            throw new Error("fixture RPC outage");
        };
        await work.processor.executeNext();
        expect(work.store.get(request.chainId, request.orderId)).toMatchObject({
            pending: true,
            failures: 1,
            proofRevision: null,
        });
        expect(
            db
                .prepare("SELECT fillability_status FROM orders WHERE id=?")
                .get(order.id),
        ).toEqual({ fillability_status: ORDER_STATUS.Fillable });
        expect(await work.processor.executeNext()).toBe(false);
        vi.mocked(Date.now).mockReturnValue(now + POLICY.retryBaseMs);
        work.rpc.onRead = undefined;
        await work.processor.executeNext();
        expect(work.store.get(request.chainId, request.orderId)).toMatchObject({
            pending: false,
            failures: 0,
        });
    });

    it("reclaims a persisted dead executor and fences its late completion", async () => {
        let work = workflow();
        work.store.admit(request, now);
        const old = work.store.claimNext(request.chainId, "old", now)!;
        db.raw.close();
        setDbPath(dbPath);
        work = workflow();
        expect(work.store.claimNext(request.chainId, "early", now + 1)).toBe(
            null,
        );
        const resumed = work.store.claimNext(
            request.chainId,
            "new",
            now + POLICY.leaseMs + 1,
        )!;
        work.store.complete(old, fillable, proof, now + POLICY.leaseMs + 2);
        expect(work.store.get(request.chainId, request.orderId)?.pending).toBe(
            true,
        );
        work.store.complete(resumed, fillable, proof, now + POLICY.leaseMs + 2);
        expect(work.store.get(request.chainId, request.orderId)?.pending).toBe(
            false,
        );
    });

    it("keeps canonical upsert rollback atomic with demand admission", async () => {
        const work = workflow();
        db.exec(
            "CREATE TEMP TRIGGER fixture_reject_demand BEFORE INSERT ON order_validation_demand BEGIN SELECT RAISE(ABORT,'fixture commit failed'); END;",
        );
        const before = db
            .prepare("SELECT state_revision FROM orders WHERE id=?")
            .get(order.id);
        try {
            await expect(
                work.domain.handleOrderUpsert({ ...upsert(), price: "555" }),
            ).rejects.toThrow("fixture commit failed");
            expect(
                db
                    .prepare("SELECT state_revision FROM orders WHERE id=?")
                    .get(order.id),
            ).toEqual(before);
            expect(work.store.get(request.chainId, request.orderId)).toBe(null);
        } finally {
            db.exec("DROP TRIGGER fixture_reject_demand");
        }
    });

    it("rejects cross-chain admission before touching current state", () => {
        const work = workflow();
        expect(() =>
            new AdmitOrderValidation(2, work.store).execute(request),
        ).toThrow("chain mismatch");
        expect(work.store.get(request.chainId, request.orderId)).toBe(null);
    });

    it("keeps canonical demand independent from an older trigger's changed anchor", async () => {
        const work = workflow();
        work.store.admit(request, now);
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=? WHERE collection_id=?",
        ).run(HEAVY_MAKER.blockNumber + 1, order.collectionId);
        work.store.admit({ ...request, minimumBlock: null }, now);
        await work.processor.executeNext();
        expect(work.rpc.reads.getOrderStatus).toBe(1);
        expect(work.store.get(request.chainId, request.orderId)).toMatchObject({
            pending: false,
            anchorIndependent: true,
        });
    });

    it("rechecks a trigger's anchor after awaited RPC and never applies its stale result", async () => {
        const work = workflow();
        work.store.admit(request, now);
        work.rpc.balance = 0n;
        work.rpc.onRead = () =>
            db
                .prepare(
                    "UPDATE collections SET bootstrap_anchor_block=? WHERE collection_id=?",
                )
                .run(HEAVY_MAKER.blockNumber + 1, order.collectionId);
        await work.processor.executeNext();
        expect(
            db
                .prepare("SELECT fillability_status FROM orders WHERE id=?")
                .get(order.id),
        ).toEqual({ fillability_status: ORDER_STATUS.Fillable });
        expect(await work.processor.executeNext()).toBe(false);
    });

    it("uses the chain/due index without a temporary sort for bounded polling", () => {
        const details = db
            .prepare(
                "EXPLAIN QUERY PLAN SELECT order_id FROM order_validation_demand WHERE chain_id=? AND pending=1 AND next_attempt_at<=? AND lease_until<=? ORDER BY next_attempt_at,lease_until,updated_at,order_id LIMIT ?",
            )
            .all(request.chainId, now, now, POLICY.batchOrders) as Array<{
            detail: string;
        }>;
        expect(details.map((row) => row.detail).join(" ")).toContain(
            "order_validation_demand_due",
        );
        expect(details.map((row) => row.detail).join(" ")).not.toContain(
            "TEMP B-TREE",
        );
    });
});
