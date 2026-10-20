import { describe, expect, it, vi } from "vitest";
import { SYNC_WORK_CLASS } from "@artgod/shared/types/sync-work-class";
import { JobDeferred } from "../src/domain/job-deferred.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import {
    ORDER_JOB_KIND,
    type OrderMakerContinuationPayload,
    type OrderUpdateByMakerPayload,
} from "../src/domain/order-jobs.js";
import { makerUpdateQueue } from "../src/domain/order-processing.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { makerUpdateHandler } from "../src/infra/queue/maker-update-handler.js";
import {
    heavyMakerHint,
    heavyMakerOrder,
    tokenSaleHint,
} from "./fixtures/heavy-maker.js";
import { makerFixtureOrigin } from "./helpers/maker-validation-workflow.js";

function job(
    payload = heavyMakerHint(),
): JobEnvelope<OrderUpdateByMakerPayload> {
    return {
        jobId: "scope-observation",
        kind: ORDER_JOB_KIND.UpdateByMaker,
        queue: makerUpdateQueue(payload),
        chainId: payload.chainId,
        payload,
        attempt: 0,
        scheduledAt: 1_000,
    };
}

describe("current maker queue contracts", () => {
    it.each([
        heavyMakerHint(),
        tokenSaleHint(heavyMakerOrder(1, { side: "sell" })),
    ])("accepts only the owning route for $scope scope", async (payload) => {
        const processor = { execute: vi.fn(), resume: vi.fn() };
        const input = job(payload);
        await makerUpdateHandler({
            chainId: input.chainId,
            queueName: input.queue,
            processor,
        })(input, makerFixtureOrigin);
        expect(processor.execute).toHaveBeenCalledOnce();
        const other =
            input.queue === QUEUE_NAMES.OrdersUpdateByMaker
                ? QUEUE_NAMES.OrdersUpdateByToken
                : QUEUE_NAMES.OrdersUpdateByMaker;
        await expect(
            makerUpdateHandler({
                chainId: input.chainId,
                queueName: other,
                processor,
            })({ ...input, queue: other }, makerFixtureOrigin),
        ).rejects.toThrow("Maker scope belongs to another queue");
        expect(processor.execute).toHaveBeenCalledOnce();
    });

    it("retains a delivery with missing replay evidence before admitting it", async () => {
        const processor = { execute: vi.fn(), resume: vi.fn() };
        const input = job();
        await expect(
            makerUpdateHandler({
                chainId: input.chainId,
                queueName: input.queue,
                processor,
            })(input),
        ).rejects.toBeInstanceOf(JobDeferred);
        expect(processor.execute).not.toHaveBeenCalled();
    });

    it("admits background hints without executing their scope in the delivery", async () => {
        const processor = { execute: vi.fn(), resume: vi.fn() };
        const input = { ...job(), workClass: SYNC_WORK_CLASS.GapRepair };
        await makerUpdateHandler({
            chainId: input.chainId,
            queueName: input.queue,
            processor,
        })(input, makerFixtureOrigin);
        expect(processor.execute).toHaveBeenCalledWith({
            jobId: input.jobId,
            payload: { ...input.payload, workClass: SYNC_WORK_CLASS.GapRepair },
            admissionOnly: true,
            origin: makerFixtureOrigin,
        });
    });

    it("resumes only a compact persisted-run identity and rejects retired mixed envelopes", async () => {
        const processor = { execute: vi.fn(), resume: vi.fn() };
        const fresh = job();
        const handler = makerUpdateHandler({
            chainId: fresh.chainId,
            queueName: fresh.queue,
            processor,
        });
        const payload: OrderMakerContinuationPayload = {
            chainId: fresh.chainId,
            runId: "retained-run",
            step: 3,
        };
        await handler(
            { ...fresh, kind: ORDER_JOB_KIND.ContinueMaker, payload },
            makerFixtureOrigin,
        );
        expect(processor.resume).toHaveBeenCalledWith({
            jobId: fresh.jobId,
            payload,
            queueName: fresh.queue,
            origin: makerFixtureOrigin,
        });
        await expect(
            handler(
                {
                    ...fresh,
                    payload: {
                        ...fresh.payload,
                        continuation: {
                            runId: payload.runId,
                            step: payload.step,
                        },
                    } as never,
                },
                makerFixtureOrigin,
            ),
        ).rejects.toThrow("Unsupported maker queue envelope");
        expect(processor.execute).not.toHaveBeenCalled();
    });
});
