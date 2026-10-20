import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import {
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
    ORDER_SEAPORT_DATA_SOURCE_KIND,
} from "../src/domain/orders.js";
import {
    ORDER_UPDATE_REASON,
    type OrderUpsertPayload,
} from "../src/domain/order-jobs.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { createAppliedSyncFixture } from "./helpers/applied-sync-fixture.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    HEAVY_MAKER as H,
    heavyMakerOrder,
    seedHeavyMaker,
} from "./fixtures/heavy-maker.js";

const NOW = H.now * 1000;
const block = (n: number) => ({ ...syncBlockFixture(n), timestamp: H.now });
const declared = heavyMakerOrder(0);
function declaration(source = "opensea"): OrderUpsertPayload {
    return {
        ...declared,
        orderId: declared.id,
        observedAt: H.now,
        source,
        rawSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
        quantity: "999",
    };
}

describe("source facts and canonical order evidence", () => {
    loadTestEnv();
    let orders: SqliteOrdersDomain;
    let demands: SqliteOrderValidationDemand;
    let owner: ReturnType<typeof createAppliedSyncFixture>;
    beforeEach(async () => {
        vi.spyOn(Date, "now").mockReturnValue(NOW);
        for (const level of ["info", "warn", "error", "debug"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        seedHeavyMaker(1);
        db.exec(
            "DELETE FROM orders; UPDATE collections SET bootstrap_anchor_block=900",
        );
        orders = new SqliteOrdersDomain(H.weth, undefined, () => H.now);
        demands = new SqliteOrderValidationDemand(orders);
        const collection = new SqliteCollectionRegistry().getCollection(1, 9)!;
        owner = createAppliedSyncFixture({
            chainId: 1,
            anchor: block(900),
            collections: [collection],
        });
    });
    afterEach(() => {
        vi.restoreAllMocks();
        db.raw.close();
    });
    const row = () =>
        db
            .prepare(
                "SELECT fillability_status,source_status,original_quantity,quantity,fillable_quantity,validation_ready,valid_until,proof_block_number FROM orders WHERE id=?",
            )
            .get(declared.id);
    function accept(to: number) {
        const current = owner.progress.chainProgress(1)!;
        const blocks = Array.from(
            { length: to - current.applied.number },
            (_, i) => block(current.applied.number + i + 1),
        );
        if (blocks.length)
            owner.commit(
                owner.applied({ blocks, shared: true, collectionIds: [9] }),
            );
    }
    function sample(n: number) {
        owner.progress.recordHeadSample(
            owner.progress.captureHeadSample(1),
            block(n),
            NOW,
        );
    }

    it("accepts a declaration without inventing remaining quantity or executability", async () => {
        await orders.handleOrderUpsert(declaration());
        expect(row()).toMatchObject({
            fillability_status: ORDER_STATUS.Unvalidated,
            source_status: ORDER_SOURCE_STATUS.Active,
            original_quantity: "1",
            quantity: null,
            fillable_quantity: null,
            validation_ready: 1,
            proof_block_number: null,
        });
        expect(demands.get(1, declared.id)).toMatchObject({ pending: true });
        expect(demands.hasReady(1, NOW)).toBe(false);
    });
    it("retains a sale without a receipt while sync catches up to its post-admission sample", async () => {
        await orders.handleOrderUpsert(declaration());
        await orders.handleOrderUpdateById({
            chainId: 1,
            orderId: declared.id,
            source: "opensea",
            reason: ORDER_UPDATE_REASON.SourceExecution,
            executionTransactionHash: "unlocatable",
            observedAt: H.now + 10_000_000,
        });
        sample(1000);
        expect(owner.storage.getBlockHash(1, 1000)).toBeNull();
        expect(demands.claimBatch(1, "fixture", NOW).claims).toEqual([]);
        accept(999);
        expect(demands.hasReady(1, NOW)).toBe(false);
        accept(1000);
        const claim = demands.claimBatch(1, "fixture", NOW).claims[0]!;
        expect(claim.checkpoint.block).toMatchObject({
            number: 1000,
            hash: block(1000).hash,
        });
        demands.completeBatch(
            [
                {
                    claim,
                    result: {
                        status: ORDER_STATUS.Fillable,
                        reason: "fixture",
                        quantities: {
                            original: "1",
                            remaining: "1",
                            fillable: "1",
                        },
                    },
                },
            ],
            {
                checkpoint: claim.checkpoint,
                block: claim.checkpoint.block,
                observedAt: NOW,
                admissionSequence: claim.demand.admissionSequence,
            },
            NOW,
        );
        expect(row()).toMatchObject({
            fillability_status: ORDER_STATUS.Fillable,
            quantity: "1",
            proof_block_number: 1000,
        });
    });
    it("coalesces equivalent retransmissions even when another source intervenes", async () => {
        await orders.handleOrderUpsert(declaration());
        await orders.handleOrderUpsert(declaration("peer-fixture"));
        const before = demands.get(1, declared.id)!;
        await orders.handleOrderUpsert({
            ...declaration(),
            observedAt: H.now + 999,
            rawPayload: { unrelated: "debug" },
        });
        expect(demands.get(1, declared.id)).toMatchObject({
            generation: before.generation,
            admissionSequence: before.admissionSequence,
        });
        expect(
            db
                .prepare("SELECT COUNT(*) AS n FROM order_source_observations")
                .get(),
        ).toEqual({ n: 2 });
    });
    it("keeps source withdrawal independent from another source and protocol status", async () => {
        await orders.handleOrderUpsert(declaration());
        await orders.handleOrderUpsert(declaration("peer-fixture"));
        await orders.handleOrderUpdateById({
            chainId: 1,
            orderId: declared.id,
            source: "opensea",
            reason: ORDER_UPDATE_REASON.Cancel,
            sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
        });
        expect(row()).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Active,
            fillability_status: ORDER_STATUS.Unvalidated,
        });
        await orders.handleOrderUpdateById({
            chainId: 1,
            orderId: declared.id,
            source: "peer-fixture",
            reason: ORDER_UPDATE_REASON.Validation,
            sourceStatus: ORDER_SOURCE_STATUS.Inactive,
        });
        expect(row()).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Inactive,
            fillability_status: ORDER_STATUS.Unvalidated,
        });
        await orders.handleOrderUpsert(declaration());
        expect(row()).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Inactive,
        });
        await orders.handleOrderUpsert(declaration("third-peer"));
        expect(row()).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Active,
        });
    });
    it("retains a withdrawal that precedes its declaration without globally cancelling the order", async () => {
        await orders.handleOrderUpdateById({
            chainId: 1,
            collectionId: 9,
            orderId: declared.id,
            source: "opensea",
            reason: ORDER_UPDATE_REASON.Cancel,
            sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
        });
        await orders.handleOrderUpsert(declaration());
        expect(row()).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Inactive,
            fillability_status: ORDER_STATUS.Unvalidated,
        });
        await orders.handleOrderUpsert(declaration("peer-fixture"));
        expect(row()).toMatchObject({
            source_status: ORDER_SOURCE_STATUS.Active,
        });
    });
    it("keeps incomplete declarations observed until immutable terms arrive", async () => {
        await orders.handleOrderUpsert({ ...declaration(), seaportData: null });
        sample(900);
        expect(row()).toMatchObject({
            validation_ready: 0,
            original_quantity: null,
            quantity: null,
        });
        expect(demands.hasReady(1, NOW)).toBe(false);
        await orders.handleOrderUpsert(declaration());
        expect(row()).toMatchObject({
            validation_ready: 1,
            original_quantity: "1",
        });
        expect(demands.hasReady(1, NOW)).toBe(false);
        sample(900);
        expect(demands.hasReady(1, NOW)).toBe(true);
    });
    it("rejects conflicting signed terms and protocol domains atomically", async () => {
        await orders.handleOrderUpsert(declaration());
        const before = demands.get(1, declared.id);
        await expect(
            orders.handleOrderUpsert({
                ...declaration("peer-fixture"),
                seaportData: { ...declared.seaportData!, salt: "987654321" },
            }),
        ).rejects.toThrow("identify");
        await expect(
            orders.handleOrderUpsert({
                ...declaration("peer-fixture"),
                seaportData: {
                    ...declared.seaportData!,
                    protocolAddress:
                        "0x0000000000000000000000000000000000000001",
                },
            }),
        ).rejects.toThrow("conflicts");
        expect(demands.get(1, declared.id)).toEqual(before);
        expect(
            db.prepare("SELECT source_id FROM order_source_observations").all(),
        ).toEqual([{ source_id: "opensea" }]);
    });
    it("uses signed expiry rather than source metadata or a remote clock", async () => {
        await orders.handleOrderUpsert({
            ...declaration(),
            validUntil: H.now - 1,
            observedAt: H.now + 1_000_000,
        });
        expect(row()).toMatchObject({ valid_until: declared.validUntil });
        expect(demands.get(1, declared.id)?.requiredAt).toBe(NOW);
    });
    it("retries admission without publishing half an observation when the demand write fails", async () => {
        db.exec(
            "CREATE TRIGGER fixture_reject_demand BEFORE INSERT ON order_validation_demand BEGIN SELECT RAISE(ABORT,'fixture demand failure'); END",
        );
        await expect(orders.handleOrderUpsert(declaration())).rejects.toThrow(
            "fixture demand failure",
        );
        expect(db.prepare("SELECT COUNT(*) AS n FROM orders").get()).toEqual({
            n: 0,
        });
        expect(
            db
                .prepare("SELECT COUNT(*) AS n FROM order_source_observations")
                .get(),
        ).toEqual({ n: 0 });
        db.exec("DROP TRIGGER fixture_reject_demand");
        await orders.handleOrderUpsert(declaration());
        expect(demands.get(1, declared.id)).toMatchObject({ pending: true });
    });
});
