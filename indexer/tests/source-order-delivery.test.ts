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
import { orderUpdateHandler } from "../src/infra/queue/order-update-handler.js";
import { ApplyOrderUpdate } from "../src/application/orders/apply-order-update.js";
import { OFFCHAIN_ORDER_SOURCE } from "../src/domain/offchain-jobs.js";
import { runWorker } from "../src/application/worker-runner.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import {
    ORDER_UPDATE_REASON,
    ORDER_JOB_KIND,
    type OrderUpdateByIdPayload,
} from "../src/domain/order-jobs.js";
import { ORDER_SOURCE_STATUS } from "../src/domain/orders.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { UNSUPPORTED_JOB_POLICY } from "../src/domain/unsupported-job.js";
import { ORDER_UPDATE_WORKER_POLICY } from "../src/domain/order-processing.js";
import type { QueueMessage, QueuePort } from "../src/ports/queue.js";
import { HEAVY_MAKER, seedHeavyMaker } from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("source queue durable admission", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(HEAVY_MAKER.now * 1000);
        vi.spyOn(logger, "error").mockImplementation(() => {});
        vi.spyOn(logger, "warn").mockImplementation(() => {});
        db.exec(
            "DELETE FROM order_validation_demand; DELETE FROM order_source_observations; DELETE FROM orders; DELETE FROM market_order_retirements; DELETE FROM collections;",
        );
    });
    afterEach(() => vi.restoreAllMocks());

    async function fixture() {
        const { sale } = seedHeavyMaker(1);
        const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth);
        const store = new SqliteOrderValidationDemand(domain);
        const apply = new ApplyOrderUpdate({
            chainId: 1,
            lifecycle: domain,
        });
        let deliver!: (
            message: QueueMessage<OrderUpdateByIdPayload>,
        ) => Promise<void>;
        const publish = vi.fn();
        const queue: QueuePort = {
            publish,
            async subscribe(_queue, handler) {
                deliver = handler as typeof deliver;
                return async () => {};
            },
            async close() {},
        };
        await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OrderLifecycle,
                consumerName: "fixture-lifecycle",
                ...ORDER_UPDATE_WORKER_POLICY,
            },
            orderUpdateHandler({
                chainId: 1,
                apply,
            }),
        );
        const message: QueueMessage<OrderUpdateByIdPayload> = {
            data: {
                jobId: "source-observation",
                kind: ORDER_JOB_KIND.UpdateById,
                queue: QUEUE_NAMES.OrderLifecycle,
                chainId: 1,
                collectionId: sale.collectionId,
                scheduledAt: HEAVY_MAKER.now * 1000,
                attempt: 1,
                payload: {
                    chainId: 1,
                    collectionId: sale.collectionId,
                    observedAt: HEAVY_MAKER.now,
                    orderId: sale.id,
                    reason: ORDER_UPDATE_REASON.Validation,
                    source: OFFCHAIN_ORDER_SOURCE.OpenSea,
                    sourceStatus: ORDER_SOURCE_STATUS.Active,
                },
            },
            ack: vi.fn(async () => {}),
            nack: vi.fn(async () => {}),
            touch: vi.fn(async () => {}),
        };
        return { sale, store, apply, deliver, message, publish };
    }

    it("uses local admission for coverage while retaining an older source timestamp for diagnostics", async () => {
        const { sale, store, deliver, message } = await fixture();
        const observedAt = HEAVY_MAKER.now - 60;
        message.data.payload.observedAt = observedAt;
        await deliver(message);
        expect(message.ack).toHaveBeenCalledOnce();
        expect(store.get(1, sale.id)?.requiredAt).toBe(HEAVY_MAKER.now * 1000);
        expect(
            db
                .prepare(
                    "SELECT source_observed_at FROM order_source_observations WHERE order_id=?",
                )
                .get(sale.id),
        ).toEqual({ source_observed_at: observedAt });
    });

    it("does not ACK a failed demand commit; retry admits once before ACK without publication", async () => {
        const { sale, store, deliver, message, publish } = await fixture();
        message.data.attempt = 50;
        db.exec(
            "CREATE TEMP TRIGGER reject_demand BEFORE INSERT ON order_validation_demand BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END;",
        );
        try {
            await deliver(message);
            expect(message.ack).not.toHaveBeenCalled();
            expect(message.nack).toHaveBeenCalledOnce();
            expect(store.get(1, sale.id)).toBeNull();
        } finally {
            db.exec("DROP TRIGGER reject_demand");
        }
        message.ack = vi.fn(async () => {
            expect(store.get(1, sale.id)?.pending).toBe(true);
        });
        await deliver(message);
        expect(message.ack).toHaveBeenCalledOnce();
        expect(publish).not.toHaveBeenCalled();
    });

    it("replays a committed admission after ACK failure without advancing its generation", async () => {
        const { sale, store, deliver, message, publish } = await fixture();
        message.ack = vi
            .fn()
            .mockRejectedValueOnce(new Error("fixture ACK interruption"))
            .mockResolvedValue(undefined);
        await deliver(message);
        const admitted = store.get(1, sale.id)!;
        expect(message.nack).toHaveBeenCalledOnce();
        await deliver(message);
        expect(store.get(1, sale.id)?.generation).toBe(admitted.generation);
        expect(publish).not.toHaveBeenCalled();
    });

    it("retains source withdrawal through repeated transaction failure until it can commit", async () => {
        const { sale, deliver, message, publish } = await fixture();
        message.data.attempt = 50;
        message.data.payload.reason = ORDER_UPDATE_REASON.Cancel;
        message.data.payload.sourceStatus = ORDER_SOURCE_STATUS.Cancelled;
        db.exec(
            "CREATE TEMP TRIGGER reject_terminal BEFORE UPDATE ON orders BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END;",
        );
        try {
            await deliver(message);
            expect(message.ack).not.toHaveBeenCalled();
            expect(publish).not.toHaveBeenCalled();
            expect(message.nack).toHaveBeenCalledWith(
                expect.objectContaining({
                    delayMs: ORDER_UPDATE_WORKER_POLICY.retryDelayMs,
                }),
            );
            expect(
                db
                    .prepare("SELECT source_status FROM orders WHERE id=?")
                    .get(sale.id),
            ).toEqual({ source_status: ORDER_SOURCE_STATUS.Active });
        } finally {
            db.exec("DROP TRIGGER reject_terminal");
        }
        await deliver(message);
        expect(message.ack).toHaveBeenCalledOnce();
        expect(
            db
                .prepare("SELECT source_status FROM orders WHERE id=?")
                .get(sale.id),
        ).toEqual({ source_status: ORDER_SOURCE_STATUS.Inactive });
    });

    it.each([false, true])(
        "retains source-scoped withdrawal before ACK, absent order=%s",
        async (absent) => {
            const { sale, deliver, message } = await fixture();
            message.data.payload = {
                chainId: 1,
                collectionId: sale.collectionId,
                source: OFFCHAIN_ORDER_SOURCE.OpenSea,
                orderId: absent ? "unseen-order" : sale.id,
                reason: ORDER_UPDATE_REASON.Cancel,
                sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
                observedAt: HEAVY_MAKER.now,
                validUntil: sale.validUntil,
            };
            message.ack = vi.fn(async () => {
                if (absent)
                    expect(
                        db
                            .prepare(
                                "SELECT source_status FROM order_source_observations WHERE order_id=?",
                            )
                            .get(message.data.payload.orderId),
                    ).toEqual({ source_status: ORDER_SOURCE_STATUS.Cancelled });
                else
                    expect(
                        db
                            .prepare(
                                "SELECT source_status FROM orders WHERE id=?",
                            )
                            .get(sale.id),
                    ).toEqual({ source_status: ORDER_SOURCE_STATUS.Inactive });
            });
            await deliver(message);
            await deliver(message);
            expect(message.ack).toHaveBeenCalledTimes(2);
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM market_order_retirements WHERE order_id=?",
                    )
                    .get(message.data.payload.orderId),
            ).toEqual({ count: 0 });
        },
    );

    it.each(["unknown-kind", "unknown-reason", "invalid-time"])(
        "keeps %s recoverable beyond the ordinary retry ceiling",
        async (fault) => {
            const { deliver, message, publish } = await fixture();
            message.data.attempt = 50;
            if (fault === "unknown-kind")
                message.data.kind = "future.order-update";
            if (fault === "unknown-reason")
                message.data.payload.reason = "future-reason";
            if (fault === "invalid-time") message.data.payload.observedAt = -1;
            await deliver(message);
            expect(message.ack).not.toHaveBeenCalled();
            expect(publish).not.toHaveBeenCalled();
            expect(message.nack).toHaveBeenCalledWith({
                delayMs: UNSUPPORTED_JOB_POLICY.retryMs,
            });
            expect(logger.error).toHaveBeenCalledOnce();
        },
    );
});
