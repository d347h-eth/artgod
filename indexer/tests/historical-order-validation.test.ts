import {
    GAP_FILL_MODE,
    RpcBudgetScheduler,
} from "@artgod/shared/evm/rpc-budget";
import { RPC_RATE_LIMIT_MODE } from "@artgod/shared/evm/rpc-resilience";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { SYNC_WORK_CLASS as CLASS } from "@artgod/shared/types/sync-work-class";
import { ApplyOrderUpdate } from "../src/application/orders/apply-order-update.js";
import {
    AdmitOrderValidation,
    ValidateOrderDemand,
} from "../src/application/orders/validate-order-demand.js";
import { RevalidateMakerOrders } from "../src/application/orders/revalidate-maker.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import {
    eventValidationRequest,
    observedOrderValidationRequest,
    ORDER_VALIDATION_DEMAND_OUTCOME as OUTCOME,
} from "../src/domain/order-validation-demand.js";
import { ORDER_UPDATE_REASON } from "../src/domain/order-jobs.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteMakerRevalidations } from "../src/infra/orders/sqlite-maker-revalidations.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import { RpcWorkScope } from "../src/infra/rpc/work-scope.js";
import { bindRpcValidationFactory } from "../src/runtime/rpc-budget.js";
import { advanceChainSyncRevision } from "../src/infra/storage/sqlite-chain-revisions.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    HeavyMakerRpc,
    HEAVY_MAKER as F,
    heavyMakerHint,
    heavyMakerOrder,
    tokenSaleHint,
    seedHeavyMaker,
    warmConduits,
} from "./fixtures/heavy-maker.js";

const now = F.now * 1000;
const order = heavyMakerOrder(0);

function workflow(rpc = new HeavyMakerRpc(), scope = new RpcWorkScope()) {
    const orders = new SqliteOrdersDomain(F.weth, async () => {
        throw new Error("Unexpected singleton validation");
    });
    const demand = new SqliteOrderValidationDemand(orders);
    const admission = new FairOrderValidationAdmission(2);
    const createSnapshot = vi.fn(
        bindRpcValidationFactory(
            scope,
            createSeaportOrderValidationFactory({
                chainId: F.chainId,
                rpc,
                conduits: warmConduits,
                conduitController: F.controller,
            }),
        ),
    );
    const makerStore = new SqliteMakerRevalidations(orders, demand);
    return {
        rpc,
        demand,
        createSnapshot,
        makerStore,
        validator: new ValidateOrderDemand({
            chainId: F.chainId,
            store: demand,
            createSnapshot,
            admission,
        }),
        maker: new RevalidateMakerOrders({
            store: makerStore,
            createSnapshot,
            admission,
        }),
        update: new ApplyOrderUpdate({
            chainId: F.chainId,
            validation: new AdmitOrderValidation(F.chainId, demand),
            lifecycle: orders,
        }),
    };
}

describe("historical hints and current-order requirements", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        vi.spyOn(Date, "now").mockReturnValue(now);
        seedHeavyMaker(1);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("reuses a newer full validation for a recovered event without using its delivery time", async () => {
        const w = workflow();
        w.demand.admit(
            observedOrderValidationRequest(F.chainId, order.id, now - 1000),
            now,
        );
        await w.validator.executeBatch();
        w.createSnapshot.mockClear();
        vi.mocked(Date.now).mockReturnValue(now + 1000);
        await w.update.execute(
            {
                chainId: F.chainId,
                orderId: order.id,
                reason: ORDER_UPDATE_REASON.Validation,
                blockNumber: F.blockNumber - 1,
            },
            now + 1000,
        );
        expect(w.demand.get(F.chainId, order.id)?.pending).toBe(false);
        expect(await w.validator.executeBatch()).toBeUndefined();
        expect(w.createSnapshot).not.toHaveBeenCalled();
        expect(
            w.demand.admit(
                observedOrderValidationRequest(F.chainId, order.id, now + 1000),
                now + 1000,
            ),
        ).toBe(OUTCOME.Pending);
    });

    it("shares completed validation between maker scans and ordinary demand in both directions", async () => {
        const w = workflow();
        await w.maker.execute({
            jobId: "maker-first",
            payload: heavyMakerHint(),
            requiredAt: now,
        });
        expect(w.demand.get(F.chainId, order.id)).toMatchObject({
            pending: false,
            proofChainRevision: 0,
        });
        expect(
            w.demand.admit(
                eventValidationRequest(F.chainId, order.id, F.blockNumber),
                now + 1000,
            ),
        ).toBe(OUTCOME.Covered);
        w.createSnapshot.mockClear();
        await w.maker.execute({
            jobId: "independent-maker",
            payload: heavyMakerHint(),
        });
        expect(w.createSnapshot).not.toHaveBeenCalled();
    });

    it.each(["ordinary", "token"])(
        "shares a completed sell-order validation from %s processing",
        async (first) => {
            const w = workflow();
            const sale = heavyMakerOrder(2, {
                maker: F.seller,
                side: "sell",
                tokenId: "6762",
            });
            const hint = tokenSaleHint(sale);
            if (first === "ordinary") {
                w.demand.admit(
                    eventValidationRequest(F.chainId, sale.id, F.blockNumber),
                    now,
                );
                await w.validator.executeBatch();
            } else {
                await w.maker.execute({
                    jobId: "token-sale-first",
                    payload: hint,
                    requiredAt: now,
                });
            }
            expect(
                w.demand.admit(
                    eventValidationRequest(F.chainId, sale.id, F.blockNumber),
                    now + 1000,
                ),
            ).toBe(OUTCOME.Covered);
            w.createSnapshot.mockClear();
            await w.maker.execute({
                jobId: "token-sale-covered",
                payload: hint,
                requiredAt: now + 1000,
            });
            expect(w.createSnapshot).not.toHaveBeenCalled();
            expect(w.demand.get(F.chainId, sale.id)).toMatchObject({
                pending: false,
                proofChainRevision: 0,
            });
        },
    );

    it("preserves a newer unmet observation while satisfying an older maker event", async () => {
        const w = workflow();
        w.demand.admit(
            observedOrderValidationRequest(F.chainId, order.id, now + 1000),
            now,
        );
        await w.maker.execute({
            jobId: "older-event",
            payload: heavyMakerHint(),
            requiredAt: now,
        });
        expect(w.demand.get(F.chainId, order.id)).toMatchObject({
            pending: true,
            requiredAt: now + 1000,
            proofAt: now,
        });
    });

    it("invalidates both validation reuse and maker coalescing after a chain rollback", async () => {
        const w = workflow();
        const input = {
            jobId: "before-rollback",
            payload: heavyMakerHint(),
            requiredAt: now,
        };
        await w.maker.execute(input);
        db.writeTransaction(() => advanceChainSyncRevision(F.chainId))();
        expect(
            w.demand.admit(
                eventValidationRequest(F.chainId, order.id, F.blockNumber),
                now,
            ),
        ).toBe(OUTCOME.Pending);
        w.createSnapshot.mockClear();
        await w.maker.execute({ ...input, jobId: "after-rollback" });
        expect(w.createSnapshot).toHaveBeenCalledOnce();
        expect(w.demand.get(F.chainId, order.id)).toMatchObject({
            pending: false,
            proofChainRevision: 1,
        });
    });

    it("rejects validation acquired before rollback without saving effects or coverage", async () => {
        const w = workflow();
        w.demand.admit(
            eventValidationRequest(F.chainId, order.id, F.blockNumber),
            now,
        );
        w.rpc.onRead = () => {
            w.rpc.onRead = undefined;
            db.writeTransaction(() => advanceChainSyncRevision(F.chainId))();
        };
        const report = await w.validator.executeBatch();
        expect(report).toMatchObject({ applied: 0, retried: 1 });
        expect(w.demand.get(F.chainId, order.id)).toMatchObject({
            pending: true,
            proofRevision: null,
            proofChainRevision: null,
        });
    });

    it("saves a raw background maker hint before publishing its main continuation", async () => {
        const w = workflow();
        await w.maker.execute({
            jobId: "raw-gap-hint",
            payload: { ...heavyMakerHint(), workClass: CLASS.GapRepair },
            requiredAt: now,
            admissionOnly: true,
        });
        expect(w.createSnapshot).not.toHaveBeenCalled();
        const row = db.prepare("SELECT job_json FROM queue_outbox").get() as {
            job_json: string;
        };
        const continuation = JSON.parse(row.job_json);
        expect(continuation.workClass).toBe(CLASS.Main);
        await w.maker.execute({
            jobId: continuation.jobId,
            payload: continuation.payload,
        });
        expect(w.createSnapshot.mock.calls[0][0].workClass).toBe(CLASS.Main);
        expect(w.demand.get(F.chainId, order.id)?.pending).toBe(false);
    });

    it.each([1.5, 0.05, GAP_FILL_MODE.Disabled, GAP_FILL_MODE.Unlimited])(
        "finishes strict current-order validation under two competing background streams with background policy %s",
        async (gapRate) => {
            vi.restoreAllMocks();
            vi.useFakeTimers();
            vi.setSystemTime(now);
            const scope = new RpcWorkScope();
            const scheduler = new RpcBudgetScheduler(
                [
                    {
                        key: "fixture-rpc",
                        limit: {
                            mode: RPC_RATE_LIMIT_MODE.Limited,
                            requestsPerSecond: 10,
                            burst: 10,
                        },
                    },
                ],
                typeof gapRate === "number"
                    ? {
                          mode: GAP_FILL_MODE.Limited,
                          requestsPerSecond: gapRate,
                          maxInFlight: 3,
                      }
                    : { mode: gapRate },
                60_000,
            );
            let id = 0,
                running = true;
            const classes: string[] = [];
            const base = new HeavyMakerRpc();
            const rpc = new Proxy(base, {
                get(target, key) {
                    const value = Reflect.get(target, key);
                    if (typeof value !== "function") return value;
                    return async (...args: unknown[]) => {
                        const workClass = scope.current();
                        classes.push(workClass);
                        const lease = await scheduler.acquire({
                            id: `validation-${++id}`,
                            endpointKey: "fixture-rpc",
                            workClass,
                        });
                        try {
                            return await value.apply(target, args);
                        } finally {
                            scheduler.release(lease);
                        }
                    };
                },
            });
            const streams = [0, 1].map(async (stream) => {
                try {
                    while (running) {
                        const lease = await scheduler.acquire({
                            id: `background-${stream}-${++id}`,
                            endpointKey: "fixture-rpc",
                            workClass: CLASS.GapRepair,
                        });
                        scheduler.release(lease);
                    }
                } catch {
                    /* Stop cancels outstanding fixture requests. */
                }
            });
            try {
                const w = workflow(rpc, scope);
                await scope.run(CLASS.GapRepair, () =>
                    w.update.execute(
                        {
                            chainId: F.chainId,
                            orderId: order.id,
                            reason: ORDER_UPDATE_REASON.Validation,
                            blockNumber: F.blockNumber,
                        },
                        now,
                    ),
                );
                const validation = w.validator.executeBatch();
                await vi.advanceTimersByTimeAsync(5000);
                expect(await validation).toMatchObject({
                    applied: 1,
                    covered: 1,
                    retried: 0,
                });
                expect(classes.length).toBeGreaterThan(3);
                expect(new Set(classes)).toEqual(new Set([CLASS.Main]));
                expect(w.demand.get(F.chainId, order.id)?.pending).toBe(false);
            } finally {
                running = false;
                scheduler.stop();
                await Promise.all(streams);
            }
        },
    );
});
