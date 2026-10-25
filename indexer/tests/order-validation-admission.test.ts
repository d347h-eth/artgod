import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { usableOrderEvidenceSql } from "@artgod/shared/database/order-evidence";
import { MARKET_DATA_STORAGE_POLICY } from "@artgod/shared/market-data/storage-policy";
import { SqliteChainProgress } from "../src/infra/storage/sqlite-chain-progress.js";
import { persistCanonicalBlocks } from "../src/infra/storage/sqlite-canonical-headers.js";
import {
    SqliteOrderValidationDemand,
    invalidateOrderValidationFromBlock,
    rebindSurvivingOrderValidationProofs,
} from "../src/infra/orders/sqlite-order-validation-demand.js";
import {
    captureChainSyncCheckpoint,
    advanceChainSyncRevision,
} from "../src/infra/storage/sqlite-chain-revisions.js";
import { ValidateOrderDemand } from "../src/application/orders/validate-order-demand.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import { ORDER_STATUS, ORDER_SOURCE_STATUS } from "../src/domain/orders.js";
import {
    eventValidationRequest,
    observedOrderValidationRequest,
    ORDER_VALIDATION_DEMAND_POLICY as POLICY,
    type OrderValidationEvidence,
    type ClaimedOrderValidation,
} from "../src/domain/order-validation-demand.js";
import { validationProjectionFixture } from "./helpers/validation-projection-fixture.js";
import type { SyncBlockHeader } from "../src/domain/chain-sync.js";
import {
    HEAVY_MAKER,
    HeavyMakerRpc,
    heavyMakerOrder,
    seedHeavyMaker,
} from "./fixtures/heavy-maker.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const now = HEAVY_MAKER.now * 1000;
const block = (number: number): SyncBlockHeader => ({
    ...syncBlockFixture(number),
    timestamp: HEAVY_MAKER.now,
});
const source = (id: string, key = "source-observation-1") =>
    observedOrderValidationRequest(1, id, key);
const event = (id: string, number: number) =>
    eventValidationRequest(1, id, number, block(number).hash);
const fillable = {
    status: ORDER_STATUS.Fillable,
    quantities: { original: "1", remaining: "1", fillable: "1" },
};

describe("source-independent validation admission at applied checkpoints", () => {
    loadTestEnv();
    let progress: SqliteChainProgress;
    let store: SqliteOrderValidationDemand;
    let databasePath: string;
    const id = heavyMakerOrder(0).id;
    beforeEach(async () => {
        vi.spyOn(Date, "now").mockReturnValue(now);
        for (const level of ["info", "warn", "error"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        databasePath = await createTempDbPath();
        setDbPath(databasePath);
        await createMigrationRunner().runMigrations();
        seedHeavyMaker(1);
        db.prepare("DELETE FROM orders WHERE id<>?").run(id);
        db.prepare(
            "UPDATE orders SET validation_ready=1,fillability_status=?",
        ).run(ORDER_STATUS.Unvalidated);
        db.exec("UPDATE collections SET bootstrap_anchor_block=900");
        progress = new SqliteChainProgress();
        store = new SqliteOrderValidationDemand(
            validationProjectionFixture(),
            progress,
        );
        progress.initializeChain(captureChainSyncCheckpoint(1), block(900));
        install(9);
    });
    afterEach(() => vi.restoreAllMocks());
    function install(collectionId: number) {
        progress.acceptCollectionBase(
            captureChainSyncCheckpoint(1),
            collectionId,
            block(900),
        );
    }
    function advance(to: number, collections = [9]) {
        const expected = progress.chainProgress(1)!;
        const headers = Array.from(
            { length: to - expected.applied.number },
            (_, i) => block(expected.applied.number + i + 1),
        );
        db.writeTransaction(() => {
            if (headers.length) {
                persistCanonicalBlocks(
                    expected.checkpoint,
                    headers,
                    () => false,
                );
                progress.advanceChain(expected, headers);
            }
            for (const collectionId of collections) {
                const scope = progress.collectionProgress(1, collectionId)!;
                const needed = Array.from(
                    { length: to - scope.applied.number },
                    (_, i) => block(scope.applied.number + i + 1),
                );
                if (needed.length) progress.advanceCollection(scope, needed);
            }
        })();
    }
    function sample(number: number) {
        progress.recordHeadSample(
            progress.captureHeadSample(1),
            block(number),
            Date.now(),
        );
    }
    function evidence(claim: ClaimedOrderValidation): OrderValidationEvidence {
        return {
            checkpoint: claim.checkpoint,
            block: claim.checkpoint.block,
            observedAt: Date.now(),
            admissionSequence: claim.demand.admissionSequence,
        };
    }
    function processor() {
        const rpc = new HeavyMakerRpc();
        vi.spyOn(rpc, "getBlock").mockImplementation(
            async (n) => ({ ...block(n), transactions: [] }) as any,
        );
        const admission = new FairOrderValidationAdmission(1);
        const run = vi.spyOn(admission, "run");
        const worker = new ValidateOrderDemand({
            chainId: 1,
            store,
            admission,
            createSnapshot: createSeaportOrderValidationFactory({
                chainId: 1,
                rpc,
                conduitController: HEAVY_MAKER.controller,
            }),
        });
        return { rpc, worker, run };
    }
    function addOrder(index: number, collectionId = 9) {
        const order = heavyMakerOrder(index, { collectionId });
        db.prepare(
            "INSERT INTO orders(id,chain_id,collection_id,kind,side,source,maker,contract_address,source_status,fillability_status,valid_until,seaport_data_json,validation_ready) VALUES (?,1,?,'seaport','buy','opensea',?,?,?,?,?,?,1)",
        ).run(
            order.id,
            collectionId,
            order.maker,
            order.contract,
            ORDER_SOURCE_STATUS.Active,
            ORDER_STATUS.Unvalidated,
            HEAVY_MAKER.now + 86400,
            JSON.stringify(order.seaportData),
        );
        return order.id;
    }

    it("retains a source hint while behind without headers, permits, leases or RPC", async () => {
        store.admit(source(id), now);
        sample(1000);
        const { worker, rpc, run } = processor();
        expect(await worker.executeBatch()).toBeUndefined();
        expect(run).not.toHaveBeenCalled();
        expect(rpc.reads).toEqual({});
        expect(store.get(1, id)).toMatchObject({
            pending: true,
            leaseOwner: null,
            failures: 0,
            requiredAt: now,
        });
        expect(
            db.prepare("SELECT MAX(block_number) AS tip FROM blocks").get(),
        ).toEqual({ tip: 900 });
        advance(1000);
        expect(await worker.executeBatch()).toMatchObject({
            applied: 1,
            covered: 1,
        });
        expect(store.get(1, id)).toMatchObject({
            pending: false,
            proofBlock: 1000,
            proofBlockHash: block(1000).hash,
        });
    });

    it("requires sampling after admission, including a stationary remote head", () => {
        const oldRead = progress.captureHeadSample(1);
        store.admit(source(id), now);
        progress.recordHeadSample(oldRead, block(900), now);
        expect(store.hasReady(1, now)).toBe(false);
        sample(900);
        expect(store.hasReady(1, now)).toBe(true);
    });

    it("waits before reserving capacity while an older collection has not joined the shared base", async () => {
        // Collection replay below the shared base can retain an NFT invalidation,
        // but that requirement alone cannot establish shared funding coverage.
        db.exec(
            "DELETE FROM collection_sync_progress; DELETE FROM chain_sync_progress",
        );
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=899 WHERE collection_id=9",
        ).run();
        progress.initializeChain(captureChainSyncCheckpoint(1), block(901));
        progress.acceptCollectionBase(
            captureChainSyncCheckpoint(1),
            9,
            block(899),
        );
        db.writeTransaction(() =>
            progress.advanceCollection(progress.collectionProgress(1, 9)!, [
                block(900),
            ]),
        )();
        store.admit(event(id, 900), now);
        const { worker, run } = processor();
        expect(store.hasReady(1, now)).toBe(false);
        expect(await worker.executeBatch()).toBeUndefined();
        expect(run).not.toHaveBeenCalled();
        expect(store.get(1, id)?.leaseOwner).toBeNull();
        db.writeTransaction(() =>
            progress.advanceCollection(progress.collectionProgress(1, 9)!, [
                block(901),
            ]),
        )();
        expect(store.hasReady(1, now)).toBe(true);
        expect(
            store.claimBatch(1, "joined", now).checkpoint?.block.number,
        ).toBe(901);
    });

    it("coalesces exact observation retries without moving local admission or generation", () => {
        store.admit(source(id), now);
        for (let i = 0; i < 2000; i++) store.admit(source(id), now + i);
        expect(store.get(1, id)).toMatchObject({
            generation: 1,
            admissionSequence: 1,
            requiredAt: now,
        });
        expect(progress.captureHeadSample(1).admissionWatermark).toBe(1);
        sample(900);
        const claim = store.claimBatch(1, "first", now).claims[0]!;
        store.completeBatch(
            [{ claim, result: fillable }],
            evidence(claim),
            now,
        );
        expect(store.admit(source(id), now + 1000)).toBe("covered");
    });

    it("does not let hundreds of unready scopes hide unrelated ready work", () => {
        for (let i = 1; i <= 250; i++)
            store.admit(source(addOrder(i, 11)), now);
        store.admit(source(id), now);
        sample(900);
        const batch = store.claimBatch(1, "ready", now);
        expect(batch.claims.map((c) => c.candidate.order.id)).toEqual([id]);
        expect(batch.scanned).toBe(1);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM order_validation_demand WHERE lease_owner IS NOT NULL",
                )
                .get(),
        ).toEqual({ count: 1 });
    });

    it("claims homogeneous collection checkpoints without taking a global minimum", () => {
        install(11);
        const other = addOrder(2, 11);
        store.admit(source(id), now);
        store.admit(source(other), now);
        sample(900);
        advance(901, [9]);
        const a = store.claimBatch(1, "a", now),
            b = store.claimBatch(1, "b", now);
        expect(
            [a.checkpoint?.collectionId, b.checkpoint?.collectionId].sort(
                (a, b) => a! - b!,
            ),
        ).toEqual([9, 11]);
        expect(
            [a.checkpoint?.block.number, b.checkpoint?.block.number].sort(
                (a, b) => a! - b!,
            ),
        ).toEqual([900, 901]);
    });

    it("lets an older claimed generation finish while retaining a later observation", () => {
        store.admit(source(id), now);
        sample(900);
        const first = store.claimBatch(1, "first", now).claims[0]!;
        store.admit(source(id, "new observation"), now + 1);
        expect(
            store.completeBatch(
                [{ claim: first, result: fillable }],
                evidence(first),
                now + 2,
            ),
        ).toMatchObject({ applied: 1, followup: 1 });
        expect(store.hasReady(1, now + 2)).toBe(false);
        sample(900);
        const next = store.claimBatch(1, "next", now + 3).claims[0]!;
        expect(next.demand.generation).toBe(2);
        expect(
            store.completeBatch(
                [{ claim: next, result: fillable }],
                evidence(next),
                now + 4,
            ),
        ).toMatchObject({ covered: 1 });
    });

    it("accepts a coherent proof after forward progress without requiring latest-tip equality", () => {
        store.admit(source(id), now);
        sample(900);
        const claim = store.claimBatch(1, "old point", now).claims[0]!;
        advance(901);
        expect(
            store.completeBatch(
                [{ claim, result: fillable }],
                evidence(claim),
                now,
            ),
        ).toMatchObject({ covered: 1 });
        expect(store.get(1, id)?.proofBlock).toBe(900);
    });

    it("never replaces a newer proof with a late unchanged-result proof", () => {
        store.admit(source(id), now);
        sample(900);
        const older = store.claimBatch(1, "old", now).claims[0]!;
        advance(901);
        const retryAt = now + POLICY.leaseMs + 1;
        const newer = store.claimBatch(1, "new", retryAt).claims[0]!;
        store.completeBatch(
            [{ claim: newer, result: fillable }],
            evidence(newer),
            retryAt,
        );
        expect(
            store.completeBatch(
                [{ claim: older, result: fillable }],
                evidence(older),
                retryAt + 1,
            ),
        ).toMatchObject({ applied: 0 });
        expect(store.get(1, id)).toMatchObject({
            proofBlock: 901,
            proofBlockHash: block(901).hash,
        });
    });

    it("gates admission and commits immediately when a mismatch is retained", () => {
        store.admit(source(id), now);
        sample(900);
        const claim = store.claimBatch(1, "claimed", now).claims[0]!;
        store.retainDispute({
            chainId: 1,
            blockNumber: 900,
            blockHash: block(900).hash,
            checkpoint: captureChainSyncCheckpoint(1),
        });
        expect(store.hasReady(1, now)).toBe(false);
        expect(() =>
            store.completeBatch(
                [{ claim, result: fillable }],
                evidence(claim),
                now,
            ),
        ).toThrow("recovery");
        expect(store.get(1, id)?.proofBlock).toBeNull();
    });

    it("survives restart and fences an expired executor's late result", () => {
        store.admit(source(id), now);
        sample(900);
        const old = store.claimBatch(1, "old", now).claims[0]!;
        db.raw.close();
        setDbPath(databasePath);
        store = new SqliteOrderValidationDemand(validationProjectionFixture());
        expect(store.claimBatch(1, "early", now + 1).claims).toEqual([]);
        const next = store.claimBatch(1, "new", now + POLICY.leaseMs + 1)
            .claims[0]!;
        expect(
            store.completeBatch(
                [{ claim: old, result: fillable }],
                evidence(old),
                now + POLICY.leaseMs + 2,
            ),
        ).toMatchObject({ lostClaims: 1 });
        expect(
            store.completeBatch(
                [{ claim: next, result: fillable }],
                evidence(next),
                now + POLICY.leaseMs + 2,
            ),
        ).toMatchObject({ covered: 1 });
    });

    it("keeps incomplete terms pending without consuming executable capacity", async () => {
        db.prepare("UPDATE orders SET validation_ready=0").run();
        store.admit(source(id), now);
        sample(900);
        const { worker, run } = processor();
        expect(await worker.executeBatch()).toBeUndefined();
        expect(run).not.toHaveBeenCalled();
        expect(store.get(1, id)).toMatchObject({
            pending: true,
            failures: 0,
            leaseOwner: null,
        });
    });

    it("retries RPC uncertainty without writing protocol invalidity", async () => {
        store.admit(source(id), now);
        sample(900);
        const { worker, rpc } = processor();
        rpc.onRead = () => {
            throw new Error("unavailable state");
        };
        expect(await worker.executeBatch()).toMatchObject({
            retried: 1,
            applied: 0,
        });
        expect(store.get(1, id)).toMatchObject({
            pending: true,
            failures: 1,
            proofBlock: null,
        });
        expect(
            db
                .prepare(
                    "SELECT fillability_status AS status FROM orders WHERE id=?",
                )
                .get(id),
        ).toEqual({ status: ORDER_STATUS.Unvalidated });
    });

    it("durably schedules bounded freshness work without new source messages", () => {
        store.admit(source(id), now);
        sample(900);
        const claim = store.claimBatch(1, "first", now).claims[0]!;
        store.completeBatch(
            [{ claim, result: fillable }],
            evidence(claim),
            now,
        );
        const due =
            now +
            MARKET_DATA_STORAGE_POLICY.orderRevalidationSeconds * 1000 +
            1;
        expect(store.scheduleDue(1, due)).toBe(1);
        expect(store.get(1, id)).toMatchObject({
            pending: true,
            admissionSequence: 2,
        });
        expect(store.hasReady(1, due)).toBe(false);
        db.prepare("UPDATE orders SET fillability_status=? WHERE id=?").run(
            ORDER_STATUS.Filled,
            id,
        );
        expect(store.scheduleDue(1, due + 1)).toBe(0);
        expect(store.get(1, id)?.pending).toBe(false);
    });

    it("certifies surviving proof at 900 across rollback at 1000 without refreshing its age or coverage", () => {
        store.admit(source(id), now);
        sample(900);
        const claim = store.claimBatch(1, "executor", now).claims[0]!;
        store.completeBatch(
            [{ claim, result: fillable }],
            evidence(claim),
            now,
        );
        const before = store.get(1, id)!;
        advance(1000);
        const visible = () =>
            !!db
                .prepare(
                    `SELECT 1 FROM orders o WHERE o.id=? AND ${usableOrderEvidenceSql({ orderAlias: "o", nowMs: "?" })}`,
                )
                .get(id, now + 1);
        expect(visible()).toBe(true);
        db.writeTransaction(() => {
            invalidateOrderValidationFromBlock(1, 1000, now + 1);
            db.prepare(
                "DELETE FROM blocks WHERE chain_id=1 AND block_number>=1000",
            ).run();
            advanceChainSyncRevision(1);
            rebindSurvivingOrderValidationProofs(1, 1000, 1);
            // Progress remains fenced until the canonical owner accepts its rewind.
            expect(visible()).toBe(false);
            progress.rewindAfterRollback(1, block(999));
        })();
        expect(visible()).toBe(true);
        expect(store.get(1, id)).toMatchObject({
            proofChainRevision: 1,
            proofBlock: 900,
            proofAt: before.proofAt,
            proofAdmissionSequence: before.proofAdmissionSequence,
            pending: false,
        });
        expect(
            db
                .prepare(
                    "SELECT proof_chain_revision,proof_at,proof_admission_sequence FROM orders WHERE id=?",
                )
                .get(id),
        ).toEqual({
            proof_chain_revision: 1,
            proof_at: now,
            proof_admission_sequence: 1,
        });
    });

    it.each(["different hash", "changed order", "old revision"])(
        "does not certify surviving-height proof with %s",
        (condition) => {
            store.admit(source(id), now);
            sample(900);
            const claim = store.claimBatch(1, "executor", now).claims[0]!;
            store.completeBatch(
                [{ claim, result: fillable }],
                evidence(claim),
                now,
            );
            if (condition === "different hash") {
                db.prepare(
                    "UPDATE orders SET proof_block_hash=? WHERE id=?",
                ).run(block(901).hash, id);
                db.prepare(
                    "UPDATE order_validation_demand SET proof_block_hash=? WHERE order_id=?",
                ).run(block(901).hash, id);
            }
            if (condition === "changed order")
                db.prepare(
                    "UPDATE orders SET state_revision=state_revision+1 WHERE id=?",
                ).run(id);
            db.writeTransaction(() => {
                advanceChainSyncRevision(1);
                if (condition === "old revision") advanceChainSyncRevision(1);
                rebindSurvivingOrderValidationProofs(
                    1,
                    1000,
                    captureChainSyncCheckpoint(1).revision,
                );
            })();
            expect(store.get(1, id)?.proofChainRevision).toBe(0);
            expect(
                db
                    .prepare(
                        "SELECT proof_chain_revision AS revision FROM orders WHERE id=?",
                    )
                    .get(id),
            ).toEqual({ revision: 0 });
        },
    );

    it("invalidates orphan latest proof even when result attribution predates the fork", () => {
        store.admit(source(id), now);
        sample(1000);
        advance(1000);
        const claim = store.claimBatch(1, "executor", now).claims[0]!;
        store.completeBatch(
            [{ claim, result: fillable }],
            evidence(claim),
            now,
        );
        db.prepare(
            "UPDATE orders SET block_number=900,block_hash=?,quantity='45',original_quantity='100',fillable_quantity='35' WHERE id=?",
        ).run(block(900).hash, id);
        // Reusable demand coverage may already have been cleaned up; the order's
        // independent proof is the authority for rollback discovery.
        db.prepare("DELETE FROM order_validation_demand WHERE order_id=?").run(
            id,
        );
        db.writeTransaction(() => {
            advanceChainSyncRevision(1);
            invalidateOrderValidationFromBlock(1, 1000, now + 1);
        })();
        expect(
            db
                .prepare(
                    "SELECT fillability_status,quantity,fillable_quantity,block_number,proof_block_number,proof_block_hash,proof_chain_revision,proof_order_revision,proof_at FROM orders WHERE id=?",
                )
                .get(id),
        ).toEqual({
            fillability_status: ORDER_STATUS.Fillable,
            quantity: "45",
            fillable_quantity: "35",
            block_number: 900,
            proof_block_number: null,
            proof_block_hash: null,
            proof_chain_revision: null,
            proof_order_revision: null,
            proof_at: null,
        });
        expect(store.get(1, id)).toMatchObject({
            pending: true,
            minimumBlock: null,
            proofBlock: null,
        });
        expect(store.hasReady(1, now + 1)).toBe(false);
    });

    it("rebinds orphaned terminal proof to a fresh admission instead of retaining its orphan hash", () => {
        store.admit(source(id), now);
        sample(900);
        advance(1000);
        const claim = store.claimBatch(1, "filled", now).claims[0]!;
        store.completeBatch(
            [{ claim, result: { status: ORDER_STATUS.Filled } }],
            evidence(claim),
            now,
        );
        db.writeTransaction(() => {
            advanceChainSyncRevision(1);
            invalidateOrderValidationFromBlock(1, 1000, now + 1);
        })();
        expect(store.get(1, id)).toMatchObject({
            pending: true,
            minimumBlock: null,
            minimumBlockHash: null,
            proofBlockHash: null,
            admissionSequence: 2,
        });
        expect(
            db
                .prepare(
                    "SELECT fillability_status AS status,source_status AS source FROM orders WHERE id=?",
                )
                .get(id),
        ).toEqual({
            status: ORDER_STATUS.Unvalidated,
            source: ORDER_SOURCE_STATUS.Active,
        });
    });
});
