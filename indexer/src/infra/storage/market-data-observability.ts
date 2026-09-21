import type { Metrics } from "@artgod/shared/observability/metrics";
import { MARKET_DATA_STORAGE_POLICY as POLICY } from "@artgod/shared/market-data/storage-policy";

export const MARKET_DATA_MAINTENANCE_ACTION = "market-data-maintenance";
export const SQLITE_STORAGE_METRIC = {
    WalAllocatedBytes: "artgod_sqlite_wal_allocated_bytes",
    HeadroomBytes: "artgod_sqlite_filesystem_available_bytes",
    BatchSeconds: "artgod_sqlite_market_maintenance_duration_seconds",
} as const;

/** Allocation warnings, not a diagnosis of checkpoint progress. No path/order labels. */
export class MarketDataObservability {
    private warnedAt = -Infinity;
    constructor(private readonly metrics: Metrics) {}

    observeMaintenance(batchMs: number): void {
        this.metrics.histogram(
            SQLITE_STORAGE_METRIC.BatchSeconds,
            batchMs / 1000,
        );
    }

    observe(
        snapshot: { walBytes: number; freeBytes: number },
        nowSeconds: number,
    ): boolean {
        this.metrics.gauge(
            SQLITE_STORAGE_METRIC.WalAllocatedBytes,
            snapshot.walBytes,
        );
        this.metrics.gauge(
            SQLITE_STORAGE_METRIC.HeadroomBytes,
            snapshot.freeBytes,
        );
        const pressure =
            snapshot.freeBytes < POLICY.diskFreeWarningBytes ||
            snapshot.walBytes >= POLICY.walSizeWarningBytes;
        if (!pressure) {
            this.warnedAt = -Infinity;
            return false;
        }
        if (nowSeconds - this.warnedAt < POLICY.storageWarningRepeatSeconds)
            return false;
        this.warnedAt = nowSeconds;
        return true;
    }
}
