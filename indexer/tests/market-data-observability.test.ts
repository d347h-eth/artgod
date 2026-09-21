import { describe, expect, it, vi } from "vitest";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";
import {
    MarketDataObservability,
    SQLITE_STORAGE_METRIC as METRIC,
} from "../src/infra/storage/market-data-observability.js";

const healthy = {
    walBytes: POLICY.journalSizeLimitBytes,
    freeBytes: POLICY.diskFreeWarningBytes * 2,
};
const metrics = () => ({
    increment: vi.fn(),
    gauge: vi.fn(),
    histogram: vi.fn(),
});
describe("SQLite filesystem observability", () => {
    it("reports allocation only, without inventing checkpoint state or continuous backlog", () => {
        const sink = metrics();
        const observer = new MarketDataObservability(sink);
        expect(observer.observe(healthy, 0)).toBe(false);
        expect(observer.observe(healthy, 1200)).toBe(false);
        expect(sink.gauge.mock.calls.map(([key]) => key)).toEqual([
            METRIC.WalAllocatedBytes,
            METRIC.HeadroomBytes,
            METRIC.WalAllocatedBytes,
            METRIC.HeadroomBytes,
        ]);
        expect(sink.increment).not.toHaveBeenCalled();
        expect(sink.histogram).not.toHaveBeenCalled();
    });
    it.each([
        { ...healthy, freeBytes: POLICY.diskFreeWarningBytes - 1 },
        { ...healthy, walBytes: POLICY.walSizeWarningBytes },
    ])("warns on the first pressure sample and limits repeats", (snapshot) => {
        const observer = new MarketDataObservability(metrics());
        expect(observer.observe(snapshot, 0)).toBe(true);
        expect(observer.observe(snapshot, 1200)).toBe(false);
        expect(
            observer.observe(snapshot, POLICY.storageWarningRepeatSeconds),
        ).toBe(true);
        expect(
            observer.observe(healthy, POLICY.storageWarningRepeatSeconds + 1),
        ).toBe(false);
        expect(
            observer.observe(snapshot, POLICY.storageWarningRepeatSeconds + 2),
        ).toBe(true);
    });
    it("keeps early warnings independent from recovery and journal reuse limits", () => {
        const observer = new MarketDataObservability(metrics());
        expect(
            observer.observe(
                {
                    walBytes: POLICY.walSizeWarningBytes - 1,
                    freeBytes: POLICY.diskFreeWarningBytes,
                },
                0,
            ),
        ).toBe(false);
        expect(POLICY.diskFreeWarningBytes).toBeGreaterThan(
            POLICY.recoveryMinFreeBytes,
        );
        expect(POLICY.walSizeWarningBytes).toBeGreaterThan(
            POLICY.journalSizeLimitBytes,
        );
    });
    it("records cleanup duration independently", () => {
        const sink = metrics();
        new MarketDataObservability(sink).observeMaintenance(125);
        expect(sink.histogram).toHaveBeenCalledWith(METRIC.BatchSeconds, 0.125);
    });
});
