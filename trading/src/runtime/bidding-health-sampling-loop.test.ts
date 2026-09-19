import { describe, expect, it, vi } from "vitest";
import { startBiddingHealthSamplingLoop } from "./bidding-health-sampling-loop.js";

describe("bidding health sampling loop", () => {
    it("waits for an admitted sample during Stop and never schedules its successor", async () => {
        vi.useFakeTimers();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const sample = vi.fn(() => gate);
        const loop = startBiddingHealthSamplingLoop({ sample }, 1000);
        let stopped = false;
        const shutdown = loop.shutdown().then(() => {
            stopped = true;
        });
        try {
            await vi.advanceTimersByTimeAsync(10_000);
            expect(stopped).toBe(false);
            expect(sample).toHaveBeenCalledTimes(1);
            release();
            await shutdown;
            await vi.advanceTimersByTimeAsync(10_000);
            expect(stopped).toBe(true);
            expect(sample).toHaveBeenCalledTimes(1);
        } finally {
            release();
            await shutdown;
            vi.useRealTimers();
        }
    });

    it("samples immediately, never overlaps, and drains once without scheduling after Stop", async () => {
        vi.useFakeTimers();
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const sample = vi
            .fn()
            .mockImplementationOnce(() => gate)
            .mockResolvedValue(undefined);
        const loop = startBiddingHealthSamplingLoop({ sample }, 1000);
        try {
            await vi.advanceTimersByTimeAsync(10_000);
            expect(sample).toHaveBeenCalledTimes(1);
            release();
            await vi.advanceTimersByTimeAsync(1000);
            expect(sample).toHaveBeenCalledTimes(2);
            await loop.shutdown();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(sample).toHaveBeenCalledTimes(2);
        } finally {
            release();
            await loop.shutdown();
            vi.useRealTimers();
        }
    });

    it("requires a valid sampling cadence", () => {
        expect(() =>
            startBiddingHealthSamplingLoop({ async sample() {} }, 0),
        ).toThrow(/positive integer/);
    });
});
