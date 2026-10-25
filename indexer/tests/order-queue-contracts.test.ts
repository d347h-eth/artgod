import { describe, expect, it, vi } from "vitest";
import type { JobEnvelope } from "../src/domain/jobs.js";
import {
    ORDER_JOB_KIND,
    ORDER_UPDATE_REASON,
    type OrderUpdateByIdPayload,
    type OrderUpsertPayload,
} from "../src/domain/order-jobs.js";
import { OFFCHAIN_ORDER_SOURCE } from "../src/domain/offchain-jobs.js";
import {
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_SOURCE_SCOPE_KIND,
} from "../src/domain/orders.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { UnsupportedJob } from "../src/domain/unsupported-job.js";
import { orderUpdateHandler } from "../src/infra/queue/order-update-handler.js";
import { orderUpsertHandler } from "../src/infra/queue/order-upsert-handler.js";

const sourceUpdate: OrderUpdateByIdPayload = {
    chainId: 1,
    collectionId: 7,
    orderId: "fixture-order",
    source: OFFCHAIN_ORDER_SOURCE.OpenSea,
    observedAt: 100,
    reason: ORDER_UPDATE_REASON.SourceExecution,
};
function updateJob(
    payload: OrderUpdateByIdPayload,
): JobEnvelope<OrderUpdateByIdPayload> {
    return {
        jobId: "fixture-update",
        chainId: 1,
        collectionId: 99,
        kind: ORDER_JOB_KIND.UpdateById,
        queue: QUEUE_NAMES.OrderLifecycle,
        payload,
        attempt: 1,
        scheduledAt: 200_000,
    };
}
function updates() {
    const apply = {
        execute: vi.fn(async (_payload: OrderUpdateByIdPayload) => {}),
    };
    return {
        apply,
        consume: orderUpdateHandler({ chainId: 1, apply }),
    };
}

describe("current source update queue contract", () => {
    it("retains the original source time and collection when delivery is retried", async () => {
        const { apply, consume } = updates();
        const job = updateJob(sourceUpdate);
        await consume(job);
        await consume({ ...job, attempt: 2, scheduledAt: 999_000 });
        expect(apply.execute).toHaveBeenNthCalledWith(1, sourceUpdate);
        expect(apply.execute).toHaveBeenNthCalledWith(2, sourceUpdate);
    });
    it.each(["collectionId", "observedAt"] as const)(
        "does not repair missing source %s from the envelope",
        async (field) => {
            const { apply, consume } = updates();
            const payload = { ...sourceUpdate };
            delete payload[field];
            await expect(consume(updateJob(payload))).rejects.toBeInstanceOf(
                UnsupportedJob,
            );
            expect(apply.execute).not.toHaveBeenCalled();
        },
    );
    it.each([
        "wrong-queue",
        "wrong-chain",
        "wrong-payload-chain",
        "canonical-fill",
        "missing-source",
        "negative-time",
        "unknown-reason",
    ])("rejects %s before source admission", async (fault) => {
        const { apply, consume } = updates();
        const job = updateJob({ ...sourceUpdate });
        if (fault === "wrong-queue") job.queue = QUEUE_NAMES.OrdersUpsert;
        if (fault === "wrong-chain") job.chainId = 2;
        if (fault === "wrong-payload-chain") job.payload.chainId = 2;
        if (fault === "canonical-fill")
            job.payload.reason = ORDER_UPDATE_REASON.Fill;
        if (fault === "missing-source")
            delete (job.payload as Partial<OrderUpdateByIdPayload>).source;
        if (fault === "negative-time") job.payload.observedAt = -1;
        if (fault === "unknown-reason")
            job.payload.reason = "future-source-update";
        await expect(consume(job)).rejects.toBeInstanceOf(UnsupportedJob);
        expect(apply.execute).not.toHaveBeenCalled();
    });
});

function upsertJob(): JobEnvelope<OrderUpsertPayload> {
    return {
        jobId: "fixture-upsert",
        chainId: 1,
        collectionId: 7,
        kind: ORDER_JOB_KIND.Upsert,
        queue: QUEUE_NAMES.OrdersUpsert,
        scheduledAt: 200_000,
        attempt: 1,
        payload: {
            chainId: 1,
            collectionId: 7,
            orderId: sourceUpdate.orderId,
            source: OFFCHAIN_ORDER_SOURCE.OpenSea,
            observedAt: 100,
            kind: "seaport",
            side: "sell",
            maker: `0x${"11".repeat(20)}`,
            contract: `0x${"22".repeat(20)}`,
            sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
            rawSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Stream,
        },
    };
}
describe("current order upsert queue contract", () => {
    it("passes original source provenance through retries and propagates writer failure", async () => {
        const orders = { handleOrderUpsert: vi.fn(async () => {}) };
        const consume = orderUpsertHandler({ chainId: 1, orders });
        const job = upsertJob();
        orders.handleOrderUpsert.mockRejectedValueOnce(
            new Error("writer unavailable"),
        );
        await expect(consume(job)).rejects.toThrow("writer unavailable");
        await consume({ ...job, attempt: 2, scheduledAt: 999_000 });
        expect(orders.handleOrderUpsert).toHaveBeenNthCalledWith(
            1,
            job.payload,
        );
        expect(orders.handleOrderUpsert).toHaveBeenNthCalledWith(
            2,
            job.payload,
        );
    });
    it.each([
        "missing-time",
        "negative-time",
        "fractional-time",
        "wrong-queue",
        "wrong-chain",
        "wrong-payload-chain",
        "missing-source",
        "missing-scope",
        "missing-channel",
    ])("rejects %s before any owner effects", async (fault) => {
        const orders = { handleOrderUpsert: vi.fn(async () => {}) };
        const consume = orderUpsertHandler({ chainId: 1, orders });
        const job = upsertJob();
        if (fault === "missing-time") delete job.payload.observedAt;
        if (fault === "negative-time") job.payload.observedAt = -1;
        if (fault === "fractional-time") job.payload.observedAt = 1.5;
        if (fault === "wrong-queue") job.queue = QUEUE_NAMES.OrderLifecycle;
        if (fault === "wrong-chain") job.chainId = 2;
        if (fault === "wrong-payload-chain") job.payload.chainId = 2;
        if (fault === "missing-source") job.payload.source = "";
        // Deliberately malformed wire data must not receive old-version defaults.
        if (fault === "missing-scope")
            delete (job.payload as Partial<OrderUpsertPayload>).sourceScopeKind;
        if (fault === "missing-channel")
            delete (job.payload as Partial<OrderUpsertPayload>).rawSourceKind;
        await expect(consume(job)).rejects.toBeInstanceOf(UnsupportedJob);
        expect(orders.handleOrderUpsert).not.toHaveBeenCalled();
    });
});
