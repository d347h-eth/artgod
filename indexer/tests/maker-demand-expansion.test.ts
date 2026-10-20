import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { RevalidateMakerOrders } from "../src/application/orders/revalidate-maker.js";
import { SqliteMakerRevalidations } from "../src/infra/orders/sqlite-maker-revalidations.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteChainProgress } from "../src/infra/storage/sqlite-chain-progress.js";
import { persistCanonicalBlocks } from "../src/infra/storage/sqlite-canonical-headers.js";
import {
    captureChainSyncCheckpoint,
    advanceChainSyncRevision,
} from "../src/infra/storage/sqlite-chain-revisions.js";
import {
    MAKER_REVALIDATION_STATUS as STATUS,
    MAKER_REVALIDATION_POLICY as POLICY,
    MakerRevalidationConflict,
} from "../src/domain/maker-revalidation.js";
import type { MakerOrderProjectionPort } from "../src/ports/maker-revalidation.js";
import { ORDER_STATUS } from "../src/domain/orders.js";
import { observedOrderValidationRequest } from "../src/domain/order-validation-demand.js";
import {
    heavyMakerHint,
    heavyMakerOrder,
    seedHeavyMaker,
    HEAVY_MAKER,
} from "./fixtures/heavy-maker.js";
import { validationProjectionFixture } from "./helpers/validation-projection-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import { loadTestEnv } from "./helpers/test-env.js";

const now = HEAVY_MAKER.now * 1000;
const origin = {
    streamId: "fixture-stream",
    consumerName: "fixture-maker",
    sequence: 1,
};
const source = (key = "observed-change-a") => ({
    jobId: key,
    observationKey: key,
    payload: { ...heavyMakerHint(), blockNumber: null, blockHash: null },
    origin,
    now,
});
const block = (number: number) => ({
    ...syncBlockFixture(number),
    timestamp: HEAVY_MAKER.now,
});

function makerProjection(): MakerOrderProjectionPort {
    const validation = validationProjectionFixture();
    return {
        captureMakerPass() {
            return db
                .prepare(
                    "SELECT MAX(id) AS upperOrderId,MAX(rowid) AS upperRowId FROM orders",
                )
                .get() as any;
        },
        selectMakerCandidates(payload, after, boundary, limit) {
            const rows = db
                .prepare(
                    "SELECT id FROM orders WHERE chain_id=? AND maker=? AND id>? AND id<=? AND rowid<=? ORDER BY id LIMIT ?",
                )
                .all(
                    payload.chainId,
                    payload.maker,
                    after,
                    boundary.upperOrderId,
                    boundary.upperRowId,
                    limit,
                ) as { id: string }[];
            return rows.flatMap(({ id }) => {
                const candidate = validation.validationCandidate(
                    observedOrderValidationRequest(
                        payload.chainId,
                        id,
                        "fixture-selection",
                    ),
                );
                return candidate
                    ? [{ ...candidate, currentAtTrigger: true }]
                    : [];
            });
        },
    };
}

describe("bounded maker scope expansion into ordinary demand", () => {
    loadTestEnv();
    let orders: MakerOrderProjectionPort;
    let demand: SqliteOrderValidationDemand;
    let store: SqliteMakerRevalidations;
    let worker: RevalidateMakerOrders;
    let progress: SqliteChainProgress;
    beforeEach(async () => {
        vi.spyOn(Date, "now").mockReturnValue(now);
        for (const level of ["info", "warn", "error"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        seedHeavyMaker(205);
        db.prepare(
            "UPDATE orders SET validation_ready=1,fillability_status=?",
        ).run(ORDER_STATUS.Unvalidated);
        db.exec("UPDATE collections SET bootstrap_anchor_block=900");
        progress = new SqliteChainProgress();
        progress.initializeChain(captureChainSyncCheckpoint(1), block(900));
        db.prepare(
            "INSERT INTO collection_ownership_bases(chain_id,collection_id,run_id,revision,anchor_block,anchor_hash) VALUES (1,9,1,0,900,?)",
        ).run(block(900).hash);
        progress.acceptCollectionBase(
            captureChainSyncCheckpoint(1),
            9,
            block(900),
        );
        orders = makerProjection();
        demand = new SqliteOrderValidationDemand(
            validationProjectionFixture(),
            progress,
        );
        store = new SqliteMakerRevalidations(orders, demand, HEAVY_MAKER.weth);
        worker = new RevalidateMakerOrders({ store });
    });
    afterEach(() => vi.restoreAllMocks());
    const pending = () =>
        (
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM order_validation_demand WHERE pending=1",
                )
                .get() as { count: number }
        ).count;
    async function continuation(runId: string) {
        const run = store.get(runId)!;
        const row = db
            .prepare("SELECT job_json FROM queue_outbox WHERE outbox_id=?")
            .get(run.wakeupOutboxId) as { job_json: string };
        const job = JSON.parse(row.job_json);
        await worker.execute({
            jobId: job.jobId,
            payload: job.payload,
            origin,
        });
        return store.get(runId)!;
    }
    function apply901() {
        db.writeTransaction(() => {
            const checkpoint = captureChainSyncCheckpoint(1);
            persistCanonicalBlocks(checkpoint, [block(901)], () => false);
            progress.advanceChain(progress.chainProgress(1)!, [block(901)]);
            progress.advanceCollection(progress.collectionProgress(1, 9)!, [
                block(901),
            ]);
        })();
    }

    it("retains scope dirtiness until every finite order is durably handed off without RPC", async () => {
        const run = store.admit(source());
        expect(run.admissionSequence).toBe(1);
        expect(
            db
                .prepare(
                    "SELECT scope_kind,scope_maker,scope_currency,required_chain_revision FROM maker_order_revalidation_runs",
                )
                .get(),
        ).toEqual({
            scope_kind: "global",
            scope_maker: HEAVY_MAKER.maker,
            scope_currency: HEAVY_MAKER.weth,
            required_chain_revision: 0,
        });
        await worker.execute(source());
        expect(pending()).toBe(100);
        expect(store.get(run.runId)?.status).toBe(STATUS.Pending);
        expect(demand.hasReady(1, now)).toBe(false);
        await continuation(run.runId);
        expect(pending()).toBe(200);
        expect(store.get(run.runId)?.status).toBe(STATUS.Pending);
        const finished = await continuation(run.runId);
        expect(finished).toMatchObject({
            status: STATUS.Completed,
            deferredOrders: 205,
            leaseOwner: null,
        });
        expect(pending()).toBe(205);
        expect(
            db
                .prepare(
                    "SELECT DISTINCT admission_sequence FROM order_validation_demand",
                )
                .all(),
        ).toEqual([{ admission_sequence: 1 }]);
        expect(progress.captureHeadSample(1).admissionWatermark).toBe(1);
        progress.recordHeadSample(
            progress.captureHeadSample(1),
            block(901),
            now,
        );
        expect(demand.claimBatch(1, "waiting", now).claims).toHaveLength(0);
        apply901();
        expect(demand.claimBatch(1, "ready", now).claims).toHaveLength(100);
    });

    it("coalesces exact source identity and ignores source/delivery clocks", () => {
        const run = store.admit(source());
        for (let n = 0; n < 100; n++)
            store.admit({ ...source(), jobId: `retry-${n}`, now: now + n });
        expect(store.get(run.runId)).toMatchObject({
            generation: 1,
            admissionSequence: 1,
            requestedAdmissionSequence: 1,
        });
        expect(progress.captureHeadSample(1).admissionWatermark).toBe(1);
        store.admit({ ...source("next-change"), now: now - 1000 });
        expect(store.get(run.runId)).toMatchObject({
            generation: 2,
            requestedAdmissionSequence: 2,
            requestedAt: now - 1000,
        });
    });

    it("preserves newer scope generation while finishing the captured finite scan", async () => {
        const run = store.admit(source());
        await worker.execute(source());
        const next = store.admit(source("change-b"));
        expect(next).toMatchObject({
            generation: 2,
            passGeneration: 1,
            admissionSequence: 1,
            requestedAdmissionSequence: 2,
        });
        await continuation(run.runId);
        const followup = await continuation(run.runId);
        expect(followup).toMatchObject({
            status: STATUS.Pending,
            afterId: "",
            passGeneration: 2,
            admissionSequence: 2,
        });
        await continuation(run.runId);
        await continuation(run.runId);
        await continuation(run.runId);
        expect(store.get(run.runId)?.status).toBe(STATUS.Completed);
        expect(
            db
                .prepare(
                    "SELECT DISTINCT admission_sequence FROM order_validation_demand",
                )
                .all(),
        ).toEqual([{ admission_sequence: 2 }]);
    });

    it("commits demand handoff and cursor atomically on storage failure", () => {
        const original = demand.admit.bind(demand);
        const admit = vi.spyOn(demand, "admit");
        admit.mockImplementation((...args) => {
            if (admit.mock.calls.length === 3)
                throw new Error("fixture writer failure");
            return original(...args);
        });
        const run = store.admit(source());
        const claimed = store.claim(run.runId, "executor", now)!;
        expect(() => store.expand(claimed, now)).toThrow(
            "fixture writer failure",
        );
        expect(pending()).toBe(0);
        expect(store.get(run.runId)).toMatchObject({
            afterId: "",
            step: 0,
            status: STATUS.Pending,
        });
    });

    it("fences expired owners across restart", () => {
        const run = store.admit(source());
        const old = store.claim(run.runId, "old", now)!;
        const restarted = new SqliteMakerRevalidations(
            orders,
            demand,
            HEAVY_MAKER.weth,
        );
        const replacement = restarted.claim(
            run.runId,
            "new",
            now + POLICY.leaseMs,
        )!;
        expect(() => store.expand(old, now + POLICY.leaseMs)).toThrow(
            MakerRevalidationConflict,
        );
        restarted.expand(replacement, now + POLICY.leaseMs);
        expect(pending()).toBe(100);
    });

    it("retains incomplete declarations without requiring readiness during expansion", async () => {
        db.exec("UPDATE orders SET validation_ready=0,seaport_data_json=NULL");
        const run = store.admit(source());
        await worker.execute(source());
        await continuation(run.runId);
        await continuation(run.runId);
        expect(pending()).toBe(205);
        expect(demand.hasReady(1, now)).toBe(false);
    });

    it("retains canonical hash identity and permits no causal source shortcut", async () => {
        apply901();
        const input = {
            ...source(),
            payload: {
                ...heavyMakerHint(),
                blockNumber: 901,
                blockHash: block(901).hash,
            },
        };
        const run = store.admit(input);
        await worker.execute(input);
        expect(run).toMatchObject({
            admissionSequence: 0,
            observationKey: null,
            chainRevision: 0,
        });
        const id = (
            db
                .prepare(
                    "SELECT order_id AS id FROM order_validation_demand LIMIT 1",
                )
                .get() as { id: string }
        ).id;
        expect(demand.get(1, id)).toMatchObject({
            minimumBlock: 901,
            minimumBlockHash: block(901).hash,
            admissionSequence: 0,
        });
        expect(demand.hasReady(1, now)).toBe(true);
        expect(() =>
            store.admit({
                ...input,
                jobId: "bad",
                payload: { ...input.payload, blockHash: null },
            }),
        ).toThrow("block number and hash");
    });

    it("never reintroduces an orphan requirement after the rollback revision changes", () => {
        apply901();
        const run = store.admit({
            ...source(),
            payload: {
                ...heavyMakerHint(),
                blockNumber: 901,
                blockHash: block(901).hash,
            },
        });
        advanceChainSyncRevision(1);
        const claimed = store.claim(run.runId, "late", now)!;
        expect(store.expand(claimed, now).status).toBe(STATUS.Completed);
        expect(pending()).toBe(0);
    });

    it("preserves a source scope across rollback and waits for the new revision sample", async () => {
        const run = store.admit(source());
        advanceChainSyncRevision(1);
        await worker.execute(source());
        await continuation(run.runId);
        await continuation(run.runId);
        expect(store.get(run.runId)?.status).toBe(STATUS.Completed);
        expect(pending()).toBe(205);
        expect(progress.admissionBarrier(1, 1)).toBeNull();
        expect(demand.hasReady(1, now)).toBe(false);
    });

    it("leaves orders admitted beyond the finite boundary owned by their initial demand", async () => {
        const run = store.admit(source());
        const late = heavyMakerOrder(999);
        db.prepare(
            "INSERT INTO orders(id,chain_id,collection_id,kind,side,source,maker,contract_address,source_status,fillability_status,valid_until) VALUES (?,1,9,'seaport','buy','opensea',?,?,'active',?,?)",
        ).run(
            late.id,
            late.maker,
            late.contract,
            ORDER_STATUS.Unvalidated,
            HEAVY_MAKER.now + 1000,
        );
        demand.admit(
            observedOrderValidationRequest(
                1,
                late.id,
                "late-initial-declaration",
            ),
            now,
        );
        await worker.execute(source());
        await continuation(run.runId);
        await continuation(run.runId);
        expect(store.get(run.runId)).toMatchObject({
            status: STATUS.Completed,
            deferredOrders: 205,
        });
        expect(demand.get(1, late.id)).toMatchObject({
            pending: true,
            admissionSequence: 2,
            observationKey: "late-initial-declaration",
        });
        expect(pending()).toBe(206);
    });

    it("retains no canonical run for an unknown maker but later admission retains its own obligation", () => {
        apply901();
        const unknown = "0x9999999999999999999999999999999999999999";
        const select = vi.spyOn(orders, "selectMakerCandidates");
        const input = {
            ...source(),
            payload: {
                ...heavyMakerHint(unknown),
                blockNumber: 901,
                blockHash: block(901).hash,
            },
        };
        expect(db.writeTransaction(() => store.admit(input))()).toBeNull();
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM maker_order_revalidation_runs",
                )
                .get(),
        ).toEqual({ count: 0 });
        expect(select.mock.calls[0]?.[3]).toBe(1);
        const id = heavyMakerOrder(0).id;
        db.prepare("UPDATE orders SET maker=? WHERE id=?").run(unknown, id);
        demand.admit(
            observedOrderValidationRequest(1, id, "late-useful-declaration"),
            now,
        );
        expect(demand.get(1, id)).toMatchObject({
            pending: true,
            admissionSequence: 1,
        });
        expect(demand.hasReady(1, now)).toBe(false);
        progress.recordHeadSample(
            progress.captureHeadSample(1),
            block(901),
            now,
        );
        expect(demand.hasReady(1, now)).toBe(true);
    });

    it("durably resumes an admitted scope even if initial publication was lost", () => {
        const run = store.admit(source());
        const [wakeup] = store.listWakeups(now + POLICY.recoveryGraceMs, 1);
        expect(wakeup!.run.runId).toBe(run.runId);
        expect(store.recoverWakeup(wakeup!, now + POLICY.recoveryGraceMs)).toBe(
            true,
        );
        expect(store.get(run.runId)?.wakeupOutboxId).not.toBeNull();
    });
});
