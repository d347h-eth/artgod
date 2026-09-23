import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorker } from "../src/application/worker-runner.js";
import { OPENSEA_RECONCILE_WORKER_POLICY as POLICY } from "../src/config/opensea-reconcile-worker.js";
import type { QueueMessage, QueuePort } from "../src/ports/queue.js";
import {
    OPENSEA_JOB_KIND,
    OPENSEA_QUEUE_NAME,
    OPENSEA_RECONCILE_REASON,
} from "../src/domain/opensea-jobs.js";

describe("worker acknowledgement renewal", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it.each([false, true])(
        "renews through several ACK deadlines and clears timers on failure=%s",
        async (fails) => {
            let deliver!: (message: QueueMessage<unknown>) => Promise<void>;
            let active: Promise<void> | undefined;
            const queue: QueuePort = {
                publish: vi.fn(),
                async subscribe(_queue, handler) {
                    deliver = handler as typeof deliver;
                    return async () => {
                        await active;
                    };
                },
                close: vi.fn(),
            };
            let settle!: () => void;
            const barrier = new Promise<void>((resolve) => {
                settle = resolve;
            });
            const stop = await runWorker(
                queue,
                {
                    queue: OPENSEA_QUEUE_NAME.Reconcile,
                    consumerName: "lease-fixture",
                    ...POLICY,
                },
                async () => {
                    await barrier;
                    if (fails) throw new Error("fixture scan failed");
                },
            );
            const message: QueueMessage<unknown> = {
                data: {
                    jobId: "lease-fixture",
                    kind: OPENSEA_JOB_KIND.ReconcileCollection,
                    queue: OPENSEA_QUEUE_NAME.Reconcile,
                    payload: {
                        chainId: 1,
                        collectionId: 99,
                        reason: OPENSEA_RECONCILE_REASON.Scheduled,
                    },
                    attempt: 1,
                    scheduledAt: 0,
                    chainId: 1,
                },
                ack: vi.fn().mockResolvedValue(undefined),
                nack: vi.fn().mockResolvedValue(undefined),
                touch: vi.fn().mockResolvedValue(undefined),
            };
            active = deliver(message);
            await vi.advanceTimersByTimeAsync(POLICY.extendLeaseMs * 10);
            expect(message.touch).toHaveBeenCalledTimes(10);
            expect(message.ack).not.toHaveBeenCalled();
            let stopped = false;
            const stopping = stop().then(() => {
                stopped = true;
            });
            await vi.advanceTimersByTimeAsync(POLICY.extendLeaseMs * 2);
            expect(stopped).toBe(false);
            expect(message.touch).toHaveBeenCalledTimes(12);
            settle();
            await stopping;
            expect(message.ack).toHaveBeenCalledTimes(fails ? 0 : 1);
            expect(message.nack).toHaveBeenCalledTimes(fails ? 1 : 0);
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(POLICY.ackWaitMs * 2);
            expect(message.touch).toHaveBeenCalledTimes(12);
        },
    );
});
