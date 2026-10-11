import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    startAutomaticSyncLoop,
    AUTOMATIC_SYNC_POLICY,
} from "../src/application/automatic-sync-executor.js";
import { RpcBudgetDeferred } from "@artgod/shared/evm/rpc-budget";

describe("continuous automatic sync loop", () => {
    let stop: (() => Promise<void>) | undefined;
    beforeEach(() => vi.useFakeTimers());
    afterEach(async () => {
        await stop?.();
        stop = undefined;
        vi.useRealTimers();
    });

    it("continues immediately while work progresses and polls only after idle", async () => {
        const runDue = vi
            .fn()
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(true)
            .mockResolvedValue(false);
        stop = startAutomaticSyncLoop({ runDue });
        await vi.advanceTimersByTimeAsync(2);
        expect(runDue).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(AUTOMATIC_SYNC_POLICY.PollMs - 2);
        expect(runDue).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(2);
        expect(runDue).toHaveBeenCalledTimes(4);
    });

    it("waits after quota deferrals or failures without overlapping calls", async () => {
        const runDue = vi
            .fn()
            .mockRejectedValueOnce(new RpcBudgetDeferred())
            .mockRejectedValueOnce(new Error("RPC unavailable"))
            .mockResolvedValue(false);
        stop = startAutomaticSyncLoop({ runDue }, 10);
        await vi.advanceTimersByTimeAsync(9);
        expect(runDue).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(10);
        expect(runDue).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(1);
        expect(runDue).toHaveBeenCalledTimes(3);
    });

    it("cancels the idle wait on shutdown and drains the current pass", async () => {
        const pending = Promise.withResolvers<boolean>();
        const runDue = vi.fn(() => pending.promise);
        stop = startAutomaticSyncLoop({ runDue });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(runDue).toHaveBeenCalledTimes(1);
        let ended = false;
        const stopping = stop().then(() => {
            ended = true;
        });
        await Promise.resolve();
        expect(ended).toBe(false);
        pending.resolve(true);
        await stopping;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(runDue).toHaveBeenCalledTimes(1);
    });
});
