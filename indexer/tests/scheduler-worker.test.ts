import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSchedulerWorker } from "../src/application/scheduler-worker.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import type { QueuePort } from "../src/ports/queue.js";

describe("realtime scheduler loop", () => {
    let stop: (() => Promise<void>) | undefined;
    beforeEach(() => vi.useFakeTimers());
    afterEach(async () => {
        await stop?.();
        stop = undefined;
        vi.useRealTimers();
    });

    it("polls realtime heads without publishing duplicate work at an unchanged head", async () => {
        const h = harness();
        stop = await h.start();
        expect(h.getHead).toHaveBeenCalledTimes(1);
        expect(h.publishedBlocks()).toEqual([98, 99, 100]);
        await vi.advanceTimersByTimeAsync(30);
        expect(h.getHead).toHaveBeenCalledTimes(4);
        expect(h.publishedBlocks()).toEqual([98, 99, 100]);
        h.head(102);
        await vi.advanceTimersByTimeAsync(10);
        expect(h.getHead).toHaveBeenCalledTimes(5);
        expect(h.publishedBlocks()).toEqual([98, 99, 100, 101, 102]);
        await stop();
        await vi.advanceTimersByTimeAsync(100);
        expect(h.getHead).toHaveBeenCalledTimes(5);
    });

    it("recovers realtime scheduling after a head read failure", async () => {
        const h = harness();
        stop = await h.start();
        h.getHead.mockRejectedValueOnce(new Error("RPC unavailable"));
        h.head(101);
        await vi.advanceTimersByTimeAsync(10);
        await vi.advanceTimersByTimeAsync(10);
        expect(h.publishedBlocks()).toEqual([98, 99, 100, 101]);
        expect(h.getHead).toHaveBeenCalledTimes(3);
    });

    it("leaves older missed blocks to automatic history repair after a large head jump", async () => {
        const h = harness();
        stop = await h.start();
        h.head(200);
        await vi.advanceTimersByTimeAsync(10);
        expect(h.publishedBlocks()).toEqual([98, 99, 100, 198, 199, 200]);
    });

    it("prevents overlapping head polls and waits for an active read on shutdown", async () => {
        const h = harness();
        stop = await h.start();
        let release!: () => void;
        h.getHead.mockImplementationOnce(
            () =>
                new Promise<number>((resolve) => {
                    release = () => resolve(100);
                }),
        );
        await vi.advanceTimersByTimeAsync(50);
        expect(h.getHead).toHaveBeenCalledTimes(2);
        let stopped = false;
        const shutdown = stop().then(() => {
            stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        release();
        await shutdown;
        await vi.advanceTimersByTimeAsync(50);
        expect(h.getHead).toHaveBeenCalledTimes(2);
    });

    it("serializes concurrent WS and polling heads without duplicate realtime ranges", async () => {
        const h = harness();
        let onHead!: (head: number) => void;
        stop = await h.start({
            start: async (listener: (head: number) => void) => {
                onHead = listener;
                return async () => {};
            },
        });
        let release!: () => void;
        h.publish.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        onHead(102);
        await vi.advanceTimersByTimeAsync(0);
        onHead(101);
        h.head(103);
        await vi.advanceTimersByTimeAsync(10);
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(h.publishedBlocks()).toEqual([98, 99, 100, 101, 102, 103]);
    });

    it("recovers failed reorg check publication at an unchanged head", async () => {
        const h = harness();
        stop = await h.start();
        h.publish.mockImplementation(async (queue) => {
            if (queue === QUEUE_NAMES.BlockCheck)
                throw new Error("block check publish failed");
        });
        h.head(101);
        await vi.advanceTimersByTimeAsync(10);
        h.publish.mockResolvedValue(undefined);
        await vi.advanceTimersByTimeAsync(10);
        const checks = h.publish.mock.calls.filter(
            ([queue]) => queue === QUEUE_NAMES.BlockCheck,
        );
        expect(checks.at(-1)?.[1].payload).toEqual({ blockNumber: 99 });
        expect(h.publishedBlocks()).toEqual([98, 99, 100, 101]);
        expect(h.getHead).toHaveBeenCalledTimes(3);
    });
});

function harness() {
    let head = 100;
    const getHead = vi.fn(async () => head);
    const publish = vi.fn<QueuePort["publish"]>(async () => {});
    return {
        getHead,
        publish,
        head(value: number) {
            head = value;
        },
        start(headSource?: {
            start(onHead: (head: number) => void): Promise<() => Promise<void>>;
        }) {
            return startSchedulerWorker(
                { getBlockNumber: getHead },
                { publish },
                { chainId: 1, sync: { reorgDepth: 3 } },
                { pollIntervalMs: 10, headSource },
            );
        },
        publishedBlocks() {
            return publish.mock.calls
                .filter(([queue]) => queue === QUEUE_NAMES.RealtimeSync)
                .map(
                    ([, job]) =>
                        (job.payload as { blockNumber: number }).blockNumber,
                );
        },
    };
}
