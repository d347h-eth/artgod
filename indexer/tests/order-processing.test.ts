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
import { SqliteCurrentAsks } from "@artgod/shared/database/current-asks";
import { logger } from "@artgod/shared/utils";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import { ApplyOrderUpdate } from "../src/application/orders/apply-order-update.js";
import {
    AdmitOrderValidation,
    ValidateOrderDemand,
} from "../src/application/orders/validate-order-demand.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { ORDER_UPDATE_REASON } from "../src/domain/order-jobs.js";
import { ORDER_SOURCE_STATUS, ORDER_STATUS } from "../src/domain/orders.js";
import {
    makerUpdateQueue,
    orderUpdateQueue,
    ORDER_PROCESSING_POLICY,
} from "../src/domain/order-processing.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    HEAVY_MAKER,
    seedHeavyMaker,
    heavyMakerHint,
    tokenSaleHint,
} from "./fixtures/heavy-maker.js";

it("shares FIFO validation capacity and releases permits after failure without starving queued work", async () => {
    const admission = new FairOrderValidationAdmission(
        ORDER_PROCESSING_POLICY.concurrentValidations,
    );
    const started: string[] = [];
    const releaseFirst = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    let active = 0,
        maximum = 0;
    const task = (name: string, wait: Promise<void>, fail = false) =>
        admission.run(async () => {
            started.push(name);
            active++;
            maximum = Math.max(maximum, active);
            try {
                await wait;
                if (fail) throw new Error("fixture failure");
                return name;
            } finally {
                active--;
            }
        });
    const first = task("maker", releaseFirst.promise, true).catch((error) =>
        String(error),
    );
    const second = task("ordinary", releaseSecond.promise);
    const token = task("token", Promise.resolve());
    expect(started).toEqual(["maker", "ordinary"]);
    releaseFirst.resolve();
    const newcomer = task("next-maker", Promise.resolve());
    await first;
    await token;
    await newcomer;
    expect(started).toEqual(["maker", "ordinary", "token", "next-maker"]);
    releaseSecond.resolve();
    await second;
    expect(maximum).toBe(ORDER_PROCESSING_POLICY.concurrentValidations);
    expect(active).toBe(0);
});

describe("order processing boundaries", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(HEAVY_MAKER.now * 1_000);
        vi.spyOn(logger, "info").mockImplementation(() => {});
        db.exec("DELETE FROM orders; DELETE FROM collections;");
    });
    afterEach(() => vi.restoreAllMocks());

    it("routes token hints and lifecycle facts independently from broad maker and ordinary work", () => {
        const { sale } = seedHeavyMaker(1);
        expect(makerUpdateQueue(heavyMakerHint())).toBe(
            QUEUE_NAMES.OrdersUpdateByMaker,
        );
        expect(makerUpdateQueue(tokenSaleHint(sale))).toBe(
            QUEUE_NAMES.OrdersUpdateByToken,
        );
        for (const reason of [
            ORDER_UPDATE_REASON.Fill,
            ORDER_UPDATE_REASON.Cancel,
        ])
            expect(
                orderUpdateQueue({ chainId: 1, orderId: sale.id, reason }),
            ).toBe(QUEUE_NAMES.OrderLifecycle);
        expect(
            orderUpdateQueue({
                chainId: 1,
                orderId: sale.id,
                reason: ORDER_UPDATE_REASON.Validation,
            }),
        ).toBe(QUEUE_NAMES.OrdersUpdateById);
        expect(
            orderUpdateQueue({
                chainId: 1,
                orderId: sale.id,
                reason: ORDER_UPDATE_REASON.Validation,
                sourceStatus: ORDER_SOURCE_STATUS.Active,
            }),
        ).toBe(QUEUE_NAMES.OrderLifecycle);
    });

    it("applies a sold-token fact while validation capacity is occupied and removes the shared current ask", async () => {
        const { sale, small } = seedHeavyMaker(1);
        const validate = vi.fn(async () => ({
            status: ORDER_STATUS.Fillable,
            reason: "fixture",
        }));
        const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth, validate);
        const store = new SqliteOrderValidationDemand(domain);
        const processor = new ApplyOrderUpdate({
            chainId: 1,
            validation: new AdmitOrderValidation(1, store),
            lifecycle: domain,
        });
        const asks = new SqliteCurrentAsks(db.raw, [HEAVY_MAKER.weth]);
        const ask = () =>
            asks.forSeller(
                sale.chainId,
                sale.collectionId,
                sale.tokenId!,
                sale.maker,
                HEAVY_MAKER.now,
            );
        expect(ask()?.id).toBe(sale.id);
        const admission = new FairOrderValidationAdmission(1);
        const blocked = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        const validator = new ValidateOrderDemand({
            chainId: 1,
            store,
            admission,
            createSnapshot: async () => {
                started.resolve();
                await blocked.promise;
                return {
                    validate,
                    canAccept: () => true,
                    finish: async () => {},
                    readCounts: () => ({ perOrder: 0, shared: 0, other: 0 }),
                    proof: {
                        observedAt: HEAVY_MAKER.now * 1_000,
                        blockNumber: HEAVY_MAKER.blockNumber,
                    },
                };
            },
        });
        await processor.execute(
            {
                chainId: 1,
                orderId: small.id,
                reason: ORDER_UPDATE_REASON.Validation,
            },
            HEAVY_MAKER.now * 1_000,
        );
        const active = validator.executeNext();
        await started.promise;
        await processor.execute(
            {
                chainId: 1,
                collectionId: sale.collectionId,
                orderId: sale.id,
                reason: ORDER_UPDATE_REASON.Fill,
                sourceStatus: ORDER_SOURCE_STATUS.Filled,
                observedAt: HEAVY_MAKER.now,
            },
            HEAVY_MAKER.now * 1_000,
        );
        expect(ask()).toBeUndefined();
        expect(store.get(1, small.id)?.pending).toBe(true);
        expect(validate).not.toHaveBeenCalled();
        blocked.resolve();
        await active;
        expect(validate).toHaveBeenCalledOnce();
        expect(store.get(1, small.id)?.pending).toBe(false);
    });

    it("preserves unsupported and wrong-chain updates for retry instead of acknowledging a no-op", async () => {
        const validation = { execute: vi.fn() };
        const lifecycle = { handleOrderUpdateById: vi.fn() };
        const processor = new ApplyOrderUpdate({
            chainId: 1,
            validation,
            lifecycle,
        });
        await expect(
            processor.execute(
                {
                    chainId: 1,
                    orderId: "fixture",
                    reason: "unsupported-future-update",
                },
                0,
            ),
        ).rejects.toThrow("Unsupported");
        await expect(
            processor.execute(
                {
                    chainId: 2,
                    orderId: "fixture",
                    reason: ORDER_UPDATE_REASON.Fill,
                },
                0,
            ),
        ).rejects.toThrow("identity");
        expect(validation.execute).not.toHaveBeenCalled();
        expect(lifecycle.handleOrderUpdateById).not.toHaveBeenCalled();
    });
});
