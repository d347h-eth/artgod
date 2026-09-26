import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSchedulerWorker } from "../src/application/scheduler-worker.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import type { QueuePort } from "../src/ports/queue.js";

describe("scheduler coverage loop", () => {
    let stop: (() => Promise<void>) | undefined;
    beforeEach(() => vi.useFakeTimers());
    afterEach(async () => {
        await stop?.();
        stop = undefined;
        vi.useRealTimers();
    });

    it("scans on startup and every HTTP poll even when the head does not change", async () => {
        const h = harness();
        stop = await h.start();
        expect(h.scan).toHaveBeenCalledExactlyOnceWith(100);
        expect(h.publishedBlocks()).toEqual([98, 99, 100]);
        await vi.advanceTimersByTimeAsync(30);
        expect(h.scan).toHaveBeenCalledTimes(4);
        expect(h.publishedBlocks()).toEqual([98, 99, 100]);
        h.head(102);
        await vi.advanceTimersByTimeAsync(10);
        expect(h.scan).toHaveBeenLastCalledWith(102);
        expect(h.publishedBlocks()).toEqual([98, 99, 100, 101, 102]);
        await stop();
        await vi.advanceTimersByTimeAsync(100);
        expect(h.scan).toHaveBeenCalledTimes(5);
    });

    it("keeps realtime scheduling alive after a gap scan failure", async () => {
        const h = harness();
        h.scan.mockRejectedValueOnce(new Error("database unavailable"));
        stop = await h.start();
        h.head(101);
        await vi.advanceTimersByTimeAsync(10);
        expect(h.publishedBlocks()).toEqual([98, 99, 100, 101]);
        expect(h.scan).toHaveBeenCalledTimes(2);
    });

    it("prevents overlapping polls and waits for active gap publication on shutdown", async () => {
        const h = harness();
        stop = await h.start();
        let release!: () => void;
        h.scan.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        await vi.advanceTimersByTimeAsync(50);
        expect(h.scan).toHaveBeenCalledTimes(2);
        let stopped = false;
        const shutdown = stop().then(() => {
            stopped = true;
        });
        await Promise.resolve();
        expect(stopped).toBe(false);
        release();
        await shutdown;
        await vi.advanceTimersByTimeAsync(50);
        expect(h.scan).toHaveBeenCalledTimes(2);
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
        expect(h.scan).toHaveBeenLastCalledWith(101);
    });
});

function harness() {
    let head = 100;
    const scan = vi.fn(async (_head: number) => {});
    const publish = vi.fn<QueuePort["publish"]>(async () => {});
    return {
        scan,
        publish,
        head(value: number) {
            head = value;
        },
        start(headSource?: {
            start(onHead: (head: number) => void): Promise<() => Promise<void>>;
        }) {
            return startSchedulerWorker(
                { getBlockNumber: async () => head },
                { publish },
                { chainId: 1, sync: { reorgDepth: 3 } },
                { scan },
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
