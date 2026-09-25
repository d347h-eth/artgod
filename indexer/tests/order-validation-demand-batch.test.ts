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
import {
    ValidateOrderDemand,
    startOrderValidationDemand,
    type OrderValidationBatchReport,
} from "../src/application/orders/validate-order-demand.js";
import type { RpcProviderPort } from "../src/ports/rpc.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import { ORDER_VALIDATION_DEMAND_POLICY as POLICY } from "../src/domain/order-validation-demand.js";
import { ORDER_VALIDATION_BATCH_POLICY } from "../src/domain/order-validation-policy.js";
import { ORDER_SOURCE_STATUS, ORDER_STATUS } from "../src/domain/orders.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import {
    BatchedHeavyMakerRpc,
    HEAVY_MAKER,
    heavyMakerOrder,
    seedHeavyMaker,
    warmConduits,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const now = HEAVY_MAKER.now * 1_000;
const request = (
    orderId: string,
    minimumBlock: number | null = HEAVY_MAKER.blockNumber,
) => ({
    chainId: HEAVY_MAKER.chainId,
    orderId,
    requiredAt: now - 1_000,
    minimumBlock,
});

function workflow(
    count: number,
    options: { rpc?: BatchedHeavyMakerRpc; admitted?: number } = {},
) {
    const other = seedHeavyMaker(count);
    const rpc = options.rpc ?? new BatchedHeavyMakerRpc();
    const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth, async () => {
        throw new Error("Unexpected singleton validation");
    });
    const store = new SqliteOrderValidationDemand(domain);
    const admission = new FairOrderValidationAdmission(2);
    const createSnapshot = vi.fn(
        createSeaportOrderValidationFactory({
            chainId: HEAVY_MAKER.chainId,
            rpc,
            conduits: warmConduits,
            conduitController: HEAVY_MAKER.controller,
        }),
    );
    const processor = new ValidateOrderDemand({
        chainId: HEAVY_MAKER.chainId,
        store,
        admission,
        createSnapshot,
    });
    const ids = Array.from({ length: count }, (_, i) => heavyMakerOrder(i).id);
    db.writeTransaction(() => {
        for (const id of ids.slice(0, options.admitted ?? count))
            store.admit(request(id), now);
    })();
    return {
        rpc,
        domain,
        store,
        processor,
        ids,
        other,
        createSnapshot,
        admission,
    };
}

/** Synthetic RPC latency per port call, including block checks, driven by fake time. */
class DelayedBatchRpc extends BatchedHeavyMakerRpc {
    active = 0;
    maximumActive = 0;
    private async delay() {
        this.active++;
        this.maximumActive = Math.max(this.maximumActive, this.active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        this.active--;
    }
    override async readContract<T>(
        input: Parameters<RpcProviderPort["readContract"]>[0],
    ): Promise<T> {
        await this.delay();
        return super.readContract<T>(input);
    }
    override async readContracts(
        input: Parameters<NonNullable<RpcProviderPort["readContracts"]>>[0],
    ) {
        await this.delay();
        return super.readContracts(input);
    }
    override async getBlockNumber() {
        await this.delay();
        return super.getBlockNumber();
    }
    override async getBlock(number: number) {
        await this.delay();
        return super.getBlock(number);
    }
}

describe("bounded demand validation batches", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(now);
        for (const level of ["info", "warn", "error"] as const)
            vi.spyOn(logger, level).mockImplementation(() => {});
        db.exec("DELETE FROM orders; DELETE FROM collections;");
    });
    afterEach(() => vi.restoreAllMocks());

    it("shares full validation for 250 demands across three bounded snapshots", async () => {
        const work = workflow(250);
        const head = vi.spyOn(work.rpc, "getBlockNumber");
        const block = vi.spyOn(work.rpc, "getBlock");
        const reports = [];
        for (;;) {
            const report = await work.processor.executeBatch();
            if (!report) break;
            reports.push(report);
        }
        expect(reports.map((r) => r.covered)).toEqual([100, 100, 50]);
        expect(work.createSnapshot).toHaveBeenCalledTimes(3);
        expect(head).toHaveBeenCalledTimes(6);
        expect(block).toHaveBeenCalledTimes(6);
        expect(work.rpc.reads).toEqual({
            getOrderStatus: 250,
            getCounter: 3,
            allowance: 3,
            balanceOf: 3,
        });
        expect(work.rpc.batches).toHaveLength(13);
        expect(work.rpc.virtualMs).toBe(220);
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM order_validation_demand WHERE pending=1",
                )
                .get(),
        ).toEqual({ count: 0 });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM orders WHERE validated_at=?",
                )
                .get(HEAVY_MAKER.now),
        ).toEqual({ count: 250 });
    });

    it("keeps balances separate for different makers and validates sell ownership", async () => {
        const work = workflow(2);
        work.store.admit(request(work.other.small.id), now);
        work.store.admit(request(work.other.sale.id), now);
        work.rpc.onRead = (params) => {
            if (params.functionName === "balanceOf")
                work.rpc.balance =
                    params.args?.[0] === HEAVY_MAKER.maker ? 0n : 10n ** 24n;
        };
        expect(await work.processor.executeBatch()).toMatchObject({
            validated: 4,
            applied: 4,
            covered: 4,
        });
        const status = (id: string) =>
            (
                db
                    .prepare(
                        "SELECT fillability_status AS status FROM orders WHERE id=?",
                    )
                    .get(id) as { status: string }
            ).status;
        expect(status(work.ids[0]!)).toBe(ORDER_STATUS.NoBalance);
        expect(status(work.ids[1]!)).toBe(ORDER_STATUS.NoBalance);
        expect(status(work.other.small.id)).toBe(ORDER_STATUS.Fillable);
        expect(status(work.other.sale.id)).toBe(ORDER_STATUS.NoBalance);
        expect(work.rpc.reads.balanceOf).toBe(2);
        expect(work.rpc.reads.ownerOf).toBe(1);
    });

    it("reports bounded cheap progress when an entire candidate page is obsolete", async () => {
        const work = workflow(POLICY.batchOrders + 1);
        db.prepare("UPDATE orders SET source_status=?").run(
            ORDER_SOURCE_STATUS.Cancelled,
        );
        expect(await work.processor.executeBatch()).toMatchObject({
            scanned: POLICY.batchOrders,
            claimed: 0,
            validated: 0,
            resolvedUnneeded: POLICY.batchOrders,
        });
        expect(await work.processor.executeBatch()).toMatchObject({
            scanned: 1,
            resolvedUnneeded: 1,
        });
        expect(await work.processor.executeBatch()).toBeUndefined();
        expect(work.createSnapshot).not.toHaveBeenCalled();
    });

    it("defers future trigger and observation requirements while completing ready orders", async () => {
        const work = workflow(3);
        work.store.admit(
            request(work.ids[0]!, HEAVY_MAKER.blockNumber + 1),
            now,
        );
        work.store.admit(
            { ...request(work.ids[1]!), requiredAt: now + 1_000 },
            now,
        );
        expect(await work.processor.executeBatch()).toMatchObject({
            validated: 1,
            covered: 1,
            retried: 2,
        });
        for (const id of work.ids.slice(0, 2))
            expect(work.store.get(1, id)).toMatchObject({
                pending: true,
                failures: 1,
                proofRevision: null,
            });
        vi.mocked(Date.now).mockReturnValue(now + POLICY.retryBaseMs);
        work.rpc.blockNumber++;
        expect(await work.processor.executeBatch()).toMatchObject({
            covered: 2,
            retried: 0,
        });
    });

    it("releases unconsumed work without coverage when the snapshot admission budget ends", async () => {
        const work = workflow(POLICY.batchOrders);
        work.rpc.onRead = (params) => {
            if (params.functionName === "getCounter")
                vi.mocked(Date.now).mockReturnValue(
                    now + ORDER_VALIDATION_BATCH_POLICY.admissionBudgetMs + 1,
                );
        };
        expect(await work.processor.executeBatch()).toMatchObject({
            validated: 1,
            covered: 1,
            released: POLICY.batchOrders - 1,
            retried: 0,
        });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM order_validation_demand WHERE pending=1 AND lease_until=0 AND proof_at IS NULL AND failures=0",
                )
                .get(),
        ).toEqual({ count: POLICY.batchOrders - 1 });
        work.rpc.onRead = undefined;
        expect(await work.processor.executeBatch()).toMatchObject({
            covered: POLICY.batchOrders - 1,
        });
    });

    it("keeps all effects uncommitted when the pinned block changes before completion", async () => {
        const work = workflow(3);
        work.rpc.balance = 0n;
        work.rpc.onRead = () => {
            work.rpc.blockHash = `0x${"cd".repeat(32)}`;
        };
        expect(await work.processor.executeBatch()).toMatchObject({
            validated: 3,
            covered: 0,
            applied: 0,
            retried: 3,
        });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM orders WHERE validated_at<>0",
                )
                .get(),
        ).toEqual({ count: 0 });
        for (const id of work.ids)
            expect(work.store.get(1, id)).toMatchObject({
                pending: true,
                failures: 1,
                proofAt: null,
            });
    });

    it("rolls back every order effect when one demand completion write fails", async () => {
        const work = workflow(3);
        const rejected = [...work.ids].sort()[1]!;
        db.exec(
            `CREATE TEMP TRIGGER reject_batch BEFORE UPDATE ON order_validation_demand WHEN NEW.pending=0 AND NEW.order_id='${rejected}' BEGIN SELECT RAISE(ABORT,'fixture batch rollback'); END;`,
        );
        try {
            expect(await work.processor.executeBatch()).toMatchObject({
                validated: 3,
                applied: 0,
                covered: 0,
                retried: 3,
            });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM orders WHERE validated_at<>0",
                    )
                    .get(),
            ).toEqual({ count: 0 });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM order_validation_demand WHERE pending=1 AND failures=1",
                    )
                    .get(),
            ).toEqual({ count: 3 });
        } finally {
            db.exec("DROP TRIGGER reject_batch");
        }
        vi.mocked(Date.now).mockReturnValue(now + POLICY.retryBaseMs);
        expect(await work.processor.executeBatch()).toMatchObject({
            covered: 3,
        });
    });

    it("commits unaffected orders while preserving changed revisions and newer demand", async () => {
        const work = workflow(4);
        work.rpc.onRead = () => {
            work.rpc.onRead = undefined;
            db.prepare(
                "UPDATE orders SET state_revision=state_revision+1 WHERE id=?",
            ).run(work.ids[0]);
            work.store.admit(
                { ...request(work.ids[1]!), requiredAt: now },
                now,
            );
            db.prepare("UPDATE orders SET source_status=? WHERE id=?").run(
                ORDER_SOURCE_STATUS.Cancelled,
                work.ids[2],
            );
        };
        expect(await work.processor.executeBatch()).toMatchObject({
            validated: 4,
            applied: 2,
            covered: 1,
            followup: 2,
            resolvedUnneeded: 1,
        });
        expect(work.store.get(1, work.ids[0]!)?.pending).toBe(true);
        expect(work.store.get(1, work.ids[1]!)?.pending).toBe(true);
        expect(work.store.get(1, work.ids[2]!)).toMatchObject({
            pending: false,
            proofAt: null,
        });
        expect(await work.processor.executeBatch()).toMatchObject({
            covered: 2,
        });
    });

    it("fences expired ownership without suppressing unrelated completions", async () => {
        const work = workflow(3);
        work.rpc.onRead = () => {
            work.rpc.onRead = undefined;
            db.prepare(
                "UPDATE order_validation_demand SET lease_until=? WHERE order_id=?",
            ).run(now, work.ids[0]);
        };
        expect(await work.processor.executeBatch()).toMatchObject({
            validated: 3,
            covered: 2,
            lostClaims: 1,
        });
        expect(work.store.get(1, work.ids[0]!)).toMatchObject({
            pending: true,
            proofAt: null,
        });
        expect(await work.processor.executeBatch()).toMatchObject({
            covered: 1,
        });
    });

    it("finishes an admitted order and releases the rest on graceful stop", async () => {
        const work = workflow(3);
        const controller = new AbortController();
        work.rpc.onRead = () => {
            controller.abort();
        };
        expect(
            await work.processor.executeBatch(controller.signal),
        ).toMatchObject({
            validated: 1,
            covered: 1,
            released: 2,
        });
        expect(
            await work.processor.executeBatch(controller.signal),
        ).toBeUndefined();
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM order_validation_demand WHERE pending=1 AND lease_until=0",
                )
                .get(),
        ).toEqual({ count: 2 });
    });

    it("claims disjoint bounded pages when two demand batches run concurrently", async () => {
        const work = workflow(POLICY.batchOrders * 2);
        let resume!: () => void;
        const held = new Promise<void>((resolve) => {
            resume = resolve;
        });
        let reads = 0;
        work.rpc.onRead = async () => {
            reads++;
            await held;
        };
        const a = work.processor.executeBatch();
        const b = work.processor.executeBatch();
        await vi.waitFor(() => expect(reads).toBe(2));
        expect(
            db
                .prepare(
                    "SELECT COUNT(DISTINCT lease_owner) AS owners,COUNT(*) AS count FROM order_validation_demand WHERE lease_until>0",
                )
                .get(),
        ).toEqual({ owners: 2, count: POLICY.batchOrders * 2 });
        resume();
        expect((await Promise.all([a, b])).map((r) => r?.covered)).toEqual([
            POLICY.batchOrders,
            POLICY.batchOrders,
        ]);
        expect(work.rpc.reads.getOrderStatus).toBe(POLICY.batchOrders * 2);
    });

    it("drains an initial backlog while accepting 30 new demands per second and serving lifecycle work", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const rpc = new DelayedBatchRpc();
        const work = workflow(1_300, { rpc, admitted: 1_000 });
        const reports: OrderValidationBatchReport[] = [];
        const stop = startOrderValidationDemand(work.processor, {
            record: (report) => {
                if (report) reports.push(report);
            },
            flush: () => {},
        });
        let admitted = 1_000;
        let producedTicks = 0;
        const producer = setInterval(() => {
            if (producedTicks === 10) return;
            producedTicks++;
            for (let i = 0; i < 30; i++)
                work.store.admit(
                    {
                        ...request(work.ids[admitted++]!),
                        requiredAt: Date.now(),
                    },
                    Date.now(),
                );
        }, 1_000);
        try {
            await vi.advanceTimersByTimeAsync(20);
            await work.domain.handleOrderUpdateById({
                chainId: 1,
                collectionId: work.other.sale.collectionId,
                orderId: work.other.sale.id,
                reason: "fixture-fill",
                sourceStatus: ORDER_SOURCE_STATUS.Filled,
                observedAt: HEAVY_MAKER.now,
            });
            expect(
                db
                    .prepare("SELECT source_status FROM orders WHERE id=?")
                    .get(work.other.sale.id),
            ).toEqual({ source_status: ORDER_SOURCE_STATUS.Filled });
            let competingFinished = false;
            const competing = work.admission.run(async () => {
                competingFinished = true;
            });
            await vi.advanceTimersByTimeAsync(980);
            await competing;
            expect(competingFinished).toBe(true);
            expect(
                reports.reduce((n, r) => n + r.covered, 0),
            ).toBeGreaterThanOrEqual(1_000);
            await vi.advanceTimersByTimeAsync(10_000);
            expect(admitted).toBe(1_300);
            expect(reports.reduce((n, r) => n + r.covered, 0)).toBe(1_300);
            expect(reports.reduce((n, r) => n + r.retried, 0)).toBe(0);
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM order_validation_demand WHERE pending=1",
                    )
                    .get(),
            ).toEqual({ count: 0 });
            expect(rpc.maximumActive).toBe(2);
            expect(work.rpc.reads.getOrderStatus).toBe(1_300);
            const calls =
                rpc.batches.length +
                (rpc.reads.getCounter ?? 0) +
                (rpc.reads.allowance ?? 0) +
                (rpc.reads.balanceOf ?? 0);
            expect(calls).toBeLessThan(200);
            process.stdout.write(
                JSON.stringify({
                    fixture: "sustained-demand",
                    initialBacklog: 1_000,
                    admittedDuringRun: 300,
                    arrivalPerSecond: 30,
                    validated: 1_300,
                    pending: 0,
                    simulatedMs: 11_000,
                    statusAggregates: rpc.batches.length,
                    contractPortCalls: calls,
                    snapshotCount: work.createSnapshot.mock.calls.length,
                    maximumConcurrentRpc: rpc.maximumActive,
                }) + "\n",
            );
        } finally {
            clearInterval(producer);
            const stopping = stop();
            await vi.advanceTimersByTimeAsync(1_000);
            await stopping;
            vi.useRealTimers();
        }
    });
});
