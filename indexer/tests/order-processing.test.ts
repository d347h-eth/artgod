import { makerValidationWorkflow } from "./helpers/maker-validation-workflow.js";
import { eventValidationRequest } from "../src/domain/order-validation-demand.js";
import { OFFCHAIN_ORDER_SOURCE } from "../src/domain/offchain-jobs.js";
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
import { ValidateOrderDemand } from "../src/application/orders/validate-order-demand.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import {
    ORDER_UPDATE_REASON,
    type OrderUpdateByIdPayload,
} from "../src/domain/order-jobs.js";
import {
    ORDER_VALIDATION_REASON,
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
} from "../src/domain/orders.js";
import {
    makerUpdateQueue,
    orderUpdateQueue,
    ORDER_PROCESSING_POLICY,
} from "../src/domain/order-processing.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { processingTelemetry } from "./helpers/processing-observability.js";
import { ORDER_PROCESSING_OPERATION as OPERATION } from "../src/application/orders/observability.js";
import {
    DOMAIN_PROCESSING_METRIC as METRIC,
    DOMAIN_PROCESSING_METRIC_LABEL as LABEL,
    DOMAIN_PROCESSING_RESULT as RESULT,
} from "../src/infra/observability/domain-processing-metric-contract.js";
import {
    HEAVY_MAKER,
    heavyMakerBlock,
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
    beforeEach(async () => {
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
            ORDER_UPDATE_REASON.Validation,
            ORDER_UPDATE_REASON.Cancel,
            ORDER_UPDATE_REASON.SourceExecution,
        ])
            expect(
                orderUpdateQueue({
                    chainId: 1,
                    orderId: sale.id,
                    source: OFFCHAIN_ORDER_SOURCE.OpenSea,
                    reason,
                }),
            ).toBe(QUEUE_NAMES.OrderLifecycle);
        expect(() =>
            orderUpdateQueue({
                chainId: 1,
                orderId: sale.id,
                reason: ORDER_UPDATE_REASON.Fill,
            } as unknown as OrderUpdateByIdPayload),
        ).toThrow("source");
    });

    it("retains a source sale while validation capacity is occupied and immediately hides its stale current ask", async () => {
        const telemetry = await processingTelemetry();
        const { sale, small } = seedHeavyMaker(1);
        const work = makerValidationWorkflow();
        const originalRead = work.rpc.readContract.bind(work.rpc);
        vi.spyOn(work.rpc, "readContract").mockImplementation(async (params) =>
            params.functionName === "ownerOf"
                ? sale.maker
                : originalRead(params),
        );
        await work.prepare();
        work.demand.admit(
            eventValidationRequest(
                1,
                sale.id,
                HEAVY_MAKER.blockNumber,
                HEAVY_MAKER.blockHash,
            ),
            Date.now(),
        );
        await work.validateReady();
        const processor = new ApplyOrderUpdate({
            chainId: 1,
            lifecycle: work.orders,
            observability: telemetry.hooks,
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
        const validate = vi.fn(async () => ({
            status: ORDER_STATUS.Fillable,
            reason: ORDER_VALIDATION_REASON.Erc20FundsAvailable,
        }));
        const blocked = Promise.withResolvers<void>();
        const started = Promise.withResolvers<void>();
        const validator = new ValidateOrderDemand({
            chainId: 1,
            store: work.demand,
            admission: new FairOrderValidationAdmission(1),
            createSnapshot: async ({ checkpoint }) => {
                started.resolve();
                await blocked.promise;
                return {
                    validate,
                    canAccept: () => true,
                    finish: async () => {},
                    readCounts: () => ({
                        perOrder: 0,
                        shared: 0,
                        other: 0,
                        statusBatches: 0,
                    }),
                    proof: { observedAt: Date.now(), block: checkpoint.block },
                };
            },
        });
        work.demand.admit(
            eventValidationRequest(
                1,
                small.id,
                HEAVY_MAKER.blockNumber,
                HEAVY_MAKER.blockHash,
            ),
            Date.now(),
        );
        const active = validator.executeBatch();
        await started.promise;
        try {
            await processor.execute({
                chainId: 1,
                collectionId: sale.collectionId,
                orderId: sale.id,
                source: OFFCHAIN_ORDER_SOURCE.OpenSea,
                sourceStatus: ORDER_SOURCE_STATUS.Active,
                reason: ORDER_UPDATE_REASON.SourceExecution,
                observedAt: HEAVY_MAKER.now,
            });
            expect(ask()).toBeUndefined();
            expect(work.demand.get(1, sale.id)?.pending).toBe(true);
            expect(work.demand.get(1, small.id)?.pending).toBe(true);
            expect(validate).not.toHaveBeenCalled();
            expect(
                db
                    .prepare(
                        "SELECT fillability_status,quantity FROM orders WHERE id=?",
                    )
                    .get(sale.id),
            ).toEqual({
                fillability_status: ORDER_STATUS.Fillable,
                quantity: "1",
            });
        } finally {
            blocked.resolve();
        }
        await active;
        expect(validate).toHaveBeenCalledOnce();
        expect(work.demand.get(1, small.id)?.pending).toBe(false);
        expect(
            await telemetry.value(METRIC.Operations, {
                [LABEL.Operation]: OPERATION.Lifecycle,
                [LABEL.Result]: RESULT.Success,
            }),
        ).toBe(1);
        expect(telemetry.apm.spans.map((span) => span.name)).toEqual([
            OPERATION.Lifecycle,
        ]);
    });

    it("preserves unsupported and wrong-chain updates for retry instead of acknowledging a no-op", async () => {
        const lifecycle = {
            handleOrderUpdateById: vi.fn(),
        };
        const processor = new ApplyOrderUpdate({
            chainId: 1,
            lifecycle,
        });
        await expect(
            processor.execute({
                chainId: 1,
                orderId: "fixture",
                source: OFFCHAIN_ORDER_SOURCE.OpenSea,
                reason: "unsupported-future-update",
            }),
        ).rejects.toThrow("Unsupported");
        await expect(
            processor.execute({
                chainId: 2,
                source: OFFCHAIN_ORDER_SOURCE.OpenSea,
                orderId: "fixture",
                reason: ORDER_UPDATE_REASON.Fill,
            }),
        ).rejects.toThrow("identity");
        expect(lifecycle.handleOrderUpdateById).not.toHaveBeenCalled();
    });
});
