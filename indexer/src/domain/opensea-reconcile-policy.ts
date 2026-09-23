import {
    OPENSEA_RECONCILE_REASON,
    type OpenSeaReconcileReason,
} from "./opensea-jobs.js";

/** Automatic jobs ensure freshness when consumed, regardless of their age or ID. */
export class OpenSeaReconcilePolicy {
    constructor(
        private readonly thresholds: {
            reconcileIntervalMs: number;
            staleStartThresholdMs: number;
        },
    ) {}

    /** Successful refreshes at or before this instant are due. Null forces a scan. */
    completedBeforeMs(
        reason: OpenSeaReconcileReason,
        now: number,
    ): number | null {
        if (reason === OPENSEA_RECONCILE_REASON.Manual) return null;
        const threshold =
            reason === OPENSEA_RECONCILE_REASON.StartupStale
                ? this.thresholds.staleStartThresholdMs
                : this.thresholds.reconcileIntervalMs;
        return now - threshold;
    }

    scheduledJobBucket(now: number): number {
        return Math.floor(
            now / Math.max(this.thresholds.reconcileIntervalMs, 1),
        );
    }
}
