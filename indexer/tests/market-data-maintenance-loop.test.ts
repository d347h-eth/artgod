import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";
import { startMarketDataMaintenanceLoop } from "../src/runtime/market-data-maintenance-loop.js";

describe("online market-data maintenance scheduling", () => {
    let stop: (() => void) | undefined;
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        stop?.();
        stop = undefined;
        vi.useRealTimers();
    });

    it("drains repeated 26,000-order bursts through bounded continuations, then returns to the idle cadence", async () => {
        let clock = 0;
        let cancelledOrders = 0;
        let priceBatches = 0;
        const remove = vi.fn(() => {
            clock += 50; // Controlled batch cost, not a hardware throughput claim.
            const count = Math.min(
                cancelledOrders,
                POLICY.maintenanceBatchRows,
            );
            cancelledOrders -= count;
            return count;
        });
        const refresh = vi.fn(() => {
            clock += 20;
            return priceBatches-- > 0 ? POLICY.maintenanceBatchRows : 0;
        });
        const onPass = vi.fn();
        const onError = vi.fn();
        stop = startMarketDataMaintenanceLoop(
            {
                removeObsoleteOrders: remove,
                refreshListingPrices: refresh,
                onPass,
                onError,
            },
            { monotonicNow: () => clock, yield: async () => {} },
        );

        for (let cycle = 0; cycle < 3; cycle++) {
            cancelledOrders += 26_000;
            priceBatches = 4;
            await vi.advanceTimersByTimeAsync(POLICY.maintenanceIntervalMs);
            expect(cancelledOrders).toBeGreaterThan(0);
            const calls = remove.mock.calls.length;
            const priceCalls = refresh.mock.calls.length;
            await vi.advanceTimersByTimeAsync(
                POLICY.maintenanceContinuationDelayMs - 1,
            );
            expect(remove).toHaveBeenCalledTimes(calls);
            await vi.advanceTimersByTimeAsync(1);
            expect(cancelledOrders).toBe(0);
            // Do not repeatedly rewrite a completed daily-price pass during catch-up.
            expect(refresh).toHaveBeenCalledTimes(priceCalls);
        }
        expect(onError).not.toHaveBeenCalled();
        expect(onPass).toHaveBeenCalledTimes(6);
        expect(
            onPass.mock.calls.every(
                ([duration]) => duration <= POLICY.maintenancePassBudgetMs + 50,
            ),
        ).toBe(true);
        const calls = remove.mock.calls.length;
        await vi.advanceTimersByTimeAsync(POLICY.maintenanceIntervalMs - 1);
        expect(remove).toHaveBeenCalledTimes(calls);
        await vi.advanceTimersByTimeAsync(1);
        expect(remove).toHaveBeenCalledTimes(calls + 1);
    });

    it("gives prices the next turn when a single order batch consumes the entire budget", async () => {
        let clock = 0;
        const remove = vi
            .fn()
            .mockImplementationOnce(() => {
                clock += POLICY.maintenancePassBudgetMs + 1;
                return POLICY.maintenanceBatchRows;
            })
            .mockReturnValue(0);
        const refresh = vi.fn(() => 0);
        stop = startMarketDataMaintenanceLoop(
            {
                removeObsoleteOrders: remove,
                refreshListingPrices: refresh,
                onPass: vi.fn(),
                onError: vi.fn(),
            },
            { monotonicNow: () => clock, yield: async () => {} },
        );
        await vi.advanceTimersByTimeAsync(POLICY.maintenanceIntervalMs);
        expect(refresh).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(
            POLICY.maintenanceContinuationDelayMs,
        );
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledTimes(2);
    });

    it("does not rapidly retry failing maintenance", async () => {
        const failure = new Error("fixture database failure");
        const remove = vi.fn(() => {
            throw failure;
        });
        const onError = vi.fn();
        stop = startMarketDataMaintenanceLoop(
            {
                removeObsoleteOrders: remove,
                refreshListingPrices: vi.fn(() => 0),
                onPass: vi.fn(),
                onError,
            },
            { yield: async () => {} },
        );
        await vi.advanceTimersByTimeAsync(POLICY.maintenanceIntervalMs);
        expect(onError).toHaveBeenCalledWith(failure);
        await vi.advanceTimersByTimeAsync(POLICY.maintenanceIntervalMs - 1);
        expect(remove).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(remove).toHaveBeenCalledTimes(2);
    });

    it("refreshes prices again on the normal cadence while cleanup remains backlogged", async () => {
        let clock = 0;
        const refresh = vi.fn(() => 0);
        stop = startMarketDataMaintenanceLoop(
            {
                removeObsoleteOrders: () => {
                    clock += POLICY.maintenancePassBudgetMs / 2;
                    return POLICY.maintenanceBatchRows;
                },
                refreshListingPrices: refresh,
                onPass: vi.fn(),
                onError: vi.fn(),
            },
            { monotonicNow: () => clock, yield: async () => {} },
        );
        await vi.advanceTimersByTimeAsync(POLICY.maintenanceIntervalMs);
        expect(refresh).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(POLICY.maintenanceIntervalMs - 1);
        expect(refresh).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it("does not overlap passes or reschedule after Stop between batches", async () => {
        const remove = vi.fn(() => POLICY.maintenanceBatchRows);
        const refresh = vi.fn(() => POLICY.maintenanceBatchRows);
        stop = startMarketDataMaintenanceLoop(
            {
                removeObsoleteOrders: remove,
                refreshListingPrices: refresh,
                onPass: vi.fn(),
                onError: vi.fn(),
            },
            {
                yield: async () => {
                    expect(vi.getTimerCount()).toBe(0);
                    stop!();
                },
            },
        );
        await vi.advanceTimersByTimeAsync(POLICY.maintenanceIntervalMs * 3);
        expect(remove).toHaveBeenCalledTimes(1);
        expect(refresh).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
