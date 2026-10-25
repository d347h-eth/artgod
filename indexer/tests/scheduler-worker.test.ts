import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSchedulerWorker } from "../src/application/scheduler-worker.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import type { QueuePort } from "../src/ports/queue.js";
import type { ChainProgressPort } from "../src/ports/chain-progress.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";

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
        expect(h.recordHeadSample).toHaveBeenCalledTimes(4);
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

    it.each([0, 1, 2])(
        "schedules only positive realtime blocks at HEAD=%s",
        async (head) => {
            const h = harness();
            h.head(head);
            stop = await h.start();
            expect(h.publishedBlocks()).toEqual(
                Array.from({ length: head }, (_, index) => index + 1),
            );
        },
    );

    it("bounds the wakeup tail while retaining the full coordinator target after a large head jump", async () => {
        const h = harness();
        stop = await h.start();
        h.head(200);
        await vi.advanceTimersByTimeAsync(10);
        expect(h.publishedBlocks()).toEqual([98, 99, 100, 198, 199, 200]);
        expect(h.recordHeadSample.mock.calls.at(-1)?.[1].number).toBe(200);
    });

    it("retries a partially published tail without scheduling older catch-up", async () => {
        const h = harness();
        stop = await h.start();
        let fail = true;
        h.publish.mockImplementation(async (_queue, job) => {
            if (
                (job.payload as { blockNumber: number }).blockNumber === 199 &&
                fail
            ) {
                fail = false;
                throw new Error("publication unavailable");
            }
        });
        h.head(200);
        await vi.advanceTimersByTimeAsync(20);
        expect(h.publishedBlocks()).toEqual([
            98, 99, 100, 198, 199, 198, 199, 200,
        ]);
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

    it("publishes only realtime work; committed blocks own their hash checks", async () => {
        const h = harness();
        stop = await h.start();
        h.head(150);
        await vi.advanceTimersByTimeAsync(10);
        expect(new Set(h.publish.mock.calls.map(([queue]) => queue))).toEqual(
            new Set([QUEUE_NAMES.RealtimeSync]),
        );
    });

    it("retains the captured watermark before the first publication", async () => {
        const h = harness();
        h.admissionSequence(7);
        h.publish.mockImplementation(async () => {
            expect(h.recordHeadSample).toHaveBeenCalledTimes(1);
            expect(h.recordHeadSample.mock.calls[0][0]).toEqual({
                checkpoint: { chainId: 1, revision: 0 },
                admissionWatermark: 7,
            });
        });
        stop = await h.start();
        expect(h.getBlock).toHaveBeenCalledWith(100, { fresh: true });
    });

    it("does not bind an admission arriving during the remote head read", async () => {
        const h = harness();
        h.admissionSequence(7);
        h.getHead.mockImplementationOnce(async () => {
            h.admissionSequence(8);
            return 100;
        });
        stop = await h.start();
        expect(h.recordHeadSample.mock.calls[0][0].admissionWatermark).toBe(7);
        await vi.advanceTimersByTimeAsync(10);
        expect(h.recordHeadSample.mock.calls[1][0].admissionWatermark).toBe(8);
        expect(h.recordHeadSample.mock.calls[1][1].number).toBe(100);
        expect(h.publishedBlocks()).toEqual([98, 99, 100]);
    });

    it("also excludes admissions arriving during full-header acquisition", async () => {
        const h = harness();
        h.getBlock.mockImplementationOnce(async (number) => {
            h.admissionSequence(1);
            return syncBlockFixture(number);
        });
        stop = await h.start();
        expect(h.recordHeadSample.mock.calls[0][0].admissionWatermark).toBe(0);
        await vi.advanceTimersByTimeAsync(10);
        expect(h.recordHeadSample.mock.calls[1][0].admissionWatermark).toBe(1);
    });

    it("keeps WS heads as hints until a later independently captured HTTP sample", async () => {
        const h = harness();
        let onHead!: (head: number) => void;
        stop = await h.start({
            start: async (listener) => {
                onHead = listener;
                return async () => {};
            },
        });
        h.admissionSequence(1);
        onHead(101);
        await vi.advanceTimersByTimeAsync(0);
        expect(h.recordHeadSample).toHaveBeenCalledTimes(1);
        expect(h.getHead).toHaveBeenCalledTimes(1);
        h.head(101);
        await vi.advanceTimersByTimeAsync(10);
        expect(h.recordHeadSample.mock.calls[1][0].admissionWatermark).toBe(1);
        expect(h.recordHeadSample.mock.calls[1][1].number).toBe(101);
    });

    it("rejects a stale revision sample and retries on the next ordinary poll", async () => {
        const h = harness();
        stop = await h.start();
        h.head(101);
        h.recordHeadSample.mockImplementationOnce(() => {
            throw new ChainSyncConflict("Sample predates rollback");
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(h.publishedBlocks()).toEqual([98, 99, 100]);
        h.revision(1);
        await vi.advanceTimersByTimeAsync(10);
        expect(
            h.recordHeadSample.mock.calls.at(-1)?.[0].checkpoint.revision,
        ).toBe(1);
        expect(h.publishedBlocks()).toEqual([98, 99, 100, 101]);
    });

    it("retains the target even when wakeup publication fails", async () => {
        const h = harness();
        h.publish.mockRejectedValueOnce(new Error("Broker reply lost"));
        await expect(h.start()).rejects.toThrow("Broker reply lost");
        expect(h.recordHeadSample).toHaveBeenCalledTimes(1);
        expect(h.recordHeadSample.mock.calls[0][1].number).toBe(100);
    });

    it("does not retain a header returned at the wrong requested height", async () => {
        const h = harness();
        h.getBlock.mockResolvedValueOnce(syncBlockFixture(99));
        await expect(h.start()).rejects.toThrow(ChainSyncConflict);
        expect(h.recordHeadSample).not.toHaveBeenCalled();
        expect(h.publish).not.toHaveBeenCalled();
    });
});

function harness() {
    let head = 100;
    let admissionSequence = 0;
    let revision = 0;
    const getHead = vi.fn(async () => head);
    const getBlock = vi.fn(
        async (number: number, _options?: { fresh: boolean }) =>
            syncBlockFixture(number),
    );
    const captureHeadSample = vi.fn<ChainProgressPort["captureHeadSample"]>(
        (chainId) => ({
            checkpoint: { chainId, revision },
            admissionWatermark: admissionSequence,
        }),
    );
    const recordHeadSample = vi.fn<ChainProgressPort["recordHeadSample"]>();
    const publish = vi.fn<QueuePort["publish"]>(async () => {});
    return {
        getHead,
        getBlock,
        captureHeadSample,
        recordHeadSample,
        publish,
        admissionSequence(value: number) {
            admissionSequence = value;
        },
        revision(value: number) {
            revision = value;
        },
        head(value: number) {
            head = value;
        },
        start(headSource?: {
            start(onHead: (head: number) => void): Promise<() => Promise<void>>;
        }) {
            return startSchedulerWorker(
                { getBlockNumber: getHead, getBlock },
                { publish },
                { captureHeadSample, recordHeadSample },
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
