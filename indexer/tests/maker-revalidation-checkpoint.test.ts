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
import { RevalidateMakerOrders } from "../src/application/orders/revalidate-maker.js";
import { createSeaportValidationBatchFactory } from "../src/application/offchain/seaport-validation-batch.js";
import { validateSeaportOrder } from "../src/application/offchain/seaport-validate.js";
import {
    MAKER_REVALIDATION_POLICY as POLICY,
    MAKER_REVALIDATION_STATUS as STATUS,
    MakerRevalidationConflict,
} from "../src/domain/maker-revalidation.js";
import { JobDeferred } from "../src/domain/job-deferred.js";
import {
    ORDER_SOURCE_SCOPE_KIND,
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
} from "../src/domain/orders.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteMakerRevalidations } from "../src/infra/orders/sqlite-maker-revalidations.js";
import type { MakerOrderProjectionPort } from "../src/ports/maker-revalidation.js";
import {
    HEAVY_MAKER,
    HeavyMakerRpc,
    heavyMakerHint,
    heavyMakerOrder,
    seedHeavyMaker,
    warmConduits,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const origin = {
    streamId: "fixture-stream-incarnation",
    consumerName: "fixture-maker-consumer",
    sequence: 10,
};
const request = {
    jobId: "fixture-maker-request",
    payload: heavyMakerHint(),
    origin,
};
const now = HEAVY_MAKER.now * 1_000;

function workflow(
    rpc = new HeavyMakerRpc(),
    wrap?: (orders: SqliteOrdersDomain) => MakerOrderProjectionPort,
) {
    const validateOrder = (order: Parameters<typeof validateSeaportOrder>[3]) =>
        validateSeaportOrder(
            rpc,
            warmConduits,
            { conduitController: HEAVY_MAKER.controller },
            order,
        );
    const orders = new SqliteOrdersDomain(HEAVY_MAKER.weth, validateOrder);
    const store = new SqliteMakerRevalidations(wrap ? wrap(orders) : orders);
    const processor = new RevalidateMakerOrders({
        store,
        validateOrder,
        wethAddress: HEAVY_MAKER.weth,
        createValidationBatch: createSeaportValidationBatchFactory({
            chainId: HEAVY_MAKER.chainId,
            wethAddress: HEAVY_MAKER.weth,
            rpc,
            conduits: warmConduits,
            conduitController: HEAVY_MAKER.controller,
        }),
    });
    return { orders, store, processor, rpc };
}

describe("durable maker checkpoints", () => {
    loadTestEnv();
    let dbPath: string;
    beforeAll(async () => {
        dbPath = await createTempDbPath();
        setDbPath(dbPath);
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(now);
        vi.spyOn(logger, "info").mockImplementation(() => {});
        vi.spyOn(logger, "error").mockImplementation(() => {});
        db.exec(
            "DELETE FROM maker_order_revalidation_runs; DELETE FROM orders; DELETE FROM collections;",
        );
    });
    afterEach(() => vi.restoreAllMocks());

    it("recovers a persisted executor that died without releasing its lease", async () => {
        seedHeavyMaker(110);
        const dead = workflow();
        const admitted = dead.store.admit({ ...request, now });
        const claimed = dead.store.claim(admitted.runId, "dead-process", now)!;
        const checkpoint = dead.store.checkpoint(
            claimed,
            dead.store.next(claimed, 100).map((candidate) => ({
                candidate,
                validation: {
                    status: ORDER_STATUS.Fillable,
                    reason: "fixture committed before death",
                },
            })),
            false,
            now,
        );
        setDbPath(dbPath); // No release: simulate losing every in-memory executor object.
        const restarted = workflow();
        await expect(restarted.processor.execute(request)).rejects.toThrow(
            JobDeferred,
        );
        const recoveredAt = now + POLICY.leaseMs + 1;
        vi.mocked(Date.now).mockReturnValue(recoveredAt);
        restarted.rpc.blockTimestamp = Math.floor(recoveredAt / 1_000);
        await restarted.processor.execute(request);
        expect(restarted.rpc.reads.getOrderStatus).toBe(10);
        expect(restarted.store.get(checkpoint.runId)).toMatchObject({
            status: STATUS.Completed,
            resolvedOrders: 110,
            leaseOwner: null,
        });
    });

    it("normalizes request identity and rejects unsupported work before admitting a run", async () => {
        seedHeavyMaker(1);
        const work = workflow();
        const stored = work.store.admit({ ...request, now });
        const equivalent = work.store.admit({
            ...request,
            now,
            payload: {
                ...request.payload,
                maker: request.payload.maker.toUpperCase(),
            },
        });
        expect(equivalent.runId).toBe(stored.runId);
        await expect(
            work.processor.execute({
                ...request,
                jobId: "unknown",
                payload: { ...request.payload, reason: "unsupported" } as never,
            }),
        ).rejects.toThrow("Unsupported maker request");
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM maker_order_revalidation_runs",
                )
                .get(),
        ).toEqual({ count: 1 });
    });

    it("reopens SQLite and resumes after the last committed context with fresh RPC state", async () => {
        seedHeavyMaker(510);
        const first = workflow();
        first.rpc.onRead = ({ functionName }) => {
            expect(db.raw.inTransaction).toBe(false);
            if (
                functionName === "getOrderStatus" &&
                first.rpc.reads.getOrderStatus === 101
            )
                throw new Error("crash before result");
        };
        await expect(first.processor.execute(request)).rejects.toThrow();
        const before = first.store.admit({ ...request, now });
        expect(before).toMatchObject({
            resolvedOrders: 100,
            status: STATUS.Pending,
            failures: 1,
            leaseOwner: null,
        });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM orders WHERE validated_at>0",
                )
                .get(),
        ).toEqual({ count: 100 });
        setDbPath(dbPath);
        const restarted = workflow();
        restarted.rpc.balance = 0n;
        await restarted.processor.execute(request);
        expect(restarted.rpc.reads.getOrderStatus).toBe(410);
        expect(restarted.store.get(before.runId)).toMatchObject({
            resolvedOrders: 510,
            status: STATUS.Completed,
        });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM orders WHERE maker=? AND fillability_status=?",
                )
                .get(HEAVY_MAKER.maker, ORDER_STATUS.NoBalance),
        ).toEqual({ count: 410 });
    });

    it.each(["failure", "busy"])(
        "rolls back effects and progress together after a write %s",
        async (fault) => {
            seedHeavyMaker(3);
            let injected = false;
            const work = workflow(new HeavyMakerRpc(), (orders) => ({
                captureMakerPass: () => orders.captureMakerPass(),
                selectMakerCandidates: (...args) =>
                    orders.selectMakerCandidates(...args),
                applyMakerResolution: (...args) => {
                    orders.applyMakerResolution(...args);
                    if (!injected) {
                        injected = true;
                        if (fault === "busy")
                            throw Object.assign(new Error("busy"), {
                                code: "SQLITE_BUSY",
                            });
                        throw new Error("crash between effect and checkpoint");
                    }
                },
            }));
            if (fault === "failure") {
                await expect(work.processor.execute(request)).rejects.toThrow(
                    "between effect and checkpoint",
                );
                expect(
                    db
                        .prepare(
                            "SELECT COUNT(*) AS count FROM orders WHERE validated_at>0",
                        )
                        .get(),
                ).toEqual({ count: 0 });
                expect(work.store.admit({ ...request, now })).toMatchObject({
                    afterId: "",
                    resolvedOrders: 0,
                });
                await work.processor.execute(request);
            } else {
                await work.processor.execute(request);
                expect(work.rpc.reads.getOrderStatus).toBe(3);
            }
            expect(work.store.admit({ ...request, now })).toMatchObject({
                status: STATUS.Completed,
                resolvedOrders: 3,
            });
        },
    );

    it("recognizes completion after a lost ACK and cleans only behind a matching broker boundary", async () => {
        seedHeavyMaker(3);
        const work = workflow();
        vi.mocked(logger.info).mockImplementation((_message, fields) => {
            if (fields?.status === STATUS.Completed)
                throw new Error("crash before ACK");
        });
        await expect(work.processor.execute(request)).rejects.toThrow(
            "before ACK",
        );
        vi.mocked(logger.info).mockImplementation(() => {});
        const calls = { ...work.rpc.reads };
        await work.processor.execute(request);
        expect(work.rpc.reads).toEqual(calls);
        expect(work.store.cleanup({ ...origin, ackFloor: 9 }, 1)).toBe(0);
        expect(
            work.store.cleanup(
                { ...origin, streamId: "replacement-stream", ackFloor: 100 },
                1,
            ),
        ).toBe(0);
        expect(work.store.cleanup({ ...origin, ackFloor: 10 }, 1)).toBe(1);
    });

    it("fences an expired executor and defers duplicate delivery without advancing progress", async () => {
        seedHeavyMaker(3);
        const work = workflow();
        const admitted = work.store.admit({ ...request, now });
        const old = work.store.claim(admitted.runId, "old-executor", now)!;
        await expect(work.processor.execute(request)).rejects.toThrow(
            JobDeferred,
        );
        const newer = work.store.claim(
            admitted.runId,
            "new-executor",
            now + POLICY.leaseMs + 1,
        )!;
        expect(newer.leaseVersion).toBe(old.leaseVersion + 1);
        const resolutions = work.store.next(old, 100).map((candidate) => ({
            candidate,
            validation: {
                status: ORDER_STATUS.NoBalance,
                reason: "fixture",
            },
        }));
        expect(() =>
            work.store.checkpoint(
                old,
                resolutions,
                true,
                now + POLICY.leaseMs + 2,
            ),
        ).toThrow(MakerRevalidationConflict);
        expect(work.store.renew(old, now + POLICY.leaseMs + 2)).toBe(false);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM orders WHERE validated_at>0",
                )
                .get(),
        ).toEqual({ count: 0 });
    });

    it("retries a changed active revision instead of checkpointing past unvalidated state", async () => {
        seedHeavyMaker(3);
        const work = workflow();
        let changed = false;
        work.rpc.onRead = ({ functionName, args }) => {
            if (!changed && functionName === "getOrderStatus") {
                changed = true;
                db.prepare(
                    "UPDATE orders SET state_revision=state_revision+1,validated_at=0 WHERE id=?",
                ).run(args![0]);
            }
        };
        await expect(work.processor.execute(request)).rejects.toThrow(
            MakerRevalidationConflict,
        );
        expect(work.store.admit({ ...request, now })).toMatchObject({
            afterId: "",
            resolvedOrders: 0,
        });
        await work.processor.execute(request);
        expect(work.store.admit({ ...request, now })).toMatchObject({
            status: STATUS.Completed,
            resolvedOrders: 3,
        });
    });

    it("resolves deleted and source-terminal candidates without reviving them", async () => {
        seedHeavyMaker(3);
        const work = workflow();
        const ids = db
            .prepare("SELECT id FROM orders WHERE maker=? ORDER BY id")
            .all(HEAVY_MAKER.maker) as { id: string }[];
        let changed = false;
        work.rpc.onRead = async () => {
            if (changed) return;
            changed = true;
            db.prepare("DELETE FROM orders WHERE id=?").run(ids[0]!.id);
            await work.orders.handleOrderUpdateById({
                chainId: 1,
                orderId: ids[1]!.id,
                reason: "cancel",
                sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
                observedAt: HEAVY_MAKER.now,
            });
        };
        await work.processor.execute(request);
        expect(work.store.admit({ ...request, now })).toMatchObject({
            status: STATUS.Completed,
            resolvedOrders: 3,
        });
        expect(
            db
                .prepare("SELECT source_status FROM orders WHERE id=?")
                .get(ids[1]!.id),
        ).toEqual({ source_status: ORDER_SOURCE_STATUS.Cancelled });
    });

    it("keeps a finite admission boundary and leaves new orders behind the cursor for follow-up", async () => {
        seedHeavyMaker(110);
        const work = workflow();
        let newId: string | undefined;
        work.rpc.onRead = async ({ functionName }) => {
            if (
                functionName !== "getOrderStatus" ||
                work.rpc.reads.getOrderStatus !== 101
            )
                return;
            const saved = work.store.admit({ ...request, now });
            let index = 10_000;
            let order = heavyMakerOrder(index);
            while (order.id >= saved.afterId) order = heavyMakerOrder(++index);
            newId = order.id;
            const outcome = await work.orders.handleOrderUpsert({
                ...order,
                side: "buy",
                source: "opensea",
                orderId: order.id,
                sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
                rawSourceKind: "rest",
                observedAt: HEAVY_MAKER.now,
                validateAfterUpsert: true,
            });
            expect(outcome.validationNeeded).toBe(true);
        };
        await work.processor.execute(request);
        expect(work.rpc.reads.getOrderStatus).toBe(110);
        expect(newId).toBeDefined();
        expect(
            db.prepare("SELECT validated_at FROM orders WHERE id=?").get(newId),
        ).toEqual({ validated_at: 0 });
        work.rpc.onRead = undefined;
        await work.processor.execute({
            ...request,
            jobId: "new-trigger",
            origin: { ...origin, sequence: 11 },
        });
        expect(
            db.prepare("SELECT validated_at FROM orders WHERE id=?").get(newId),
        ).toEqual({ validated_at: HEAVY_MAKER.now });
    });
});
