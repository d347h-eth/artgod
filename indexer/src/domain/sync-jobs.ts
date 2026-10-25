import {
    BACKFILL_SOURCE,
    type BackfillSource,
} from "@artgod/shared/types/sync-backfill";
import type { JobEnvelope } from "./jobs.js";
import { QUEUE_NAMES } from "./queues.js";
export { BACKFILL_SOURCE } from "@artgod/shared/types/sync-backfill";

export const SYNC_JOB_KIND = {
    RealtimeBlock: "sync.realtime.block",
    BackfillRange: "sync.backfill.range",
} as const;

export type RealtimeSyncPayload = {
    blockNumber: number;
};

// Only manual facts-only requests and bootstrap coordinator wakeups use this
// transport. Automatic gap and recovery work belongs to retained SQLite state.
export type BackfillSyncPayload = {
    fromBlock: number;
    toBlock: number;
    source: BackfillSource;
};

export function decodeBackfillSyncJob(
    job: JobEnvelope,
): JobEnvelope<BackfillSyncPayload> | null {
    if (
        job.kind !== SYNC_JOB_KIND.BackfillRange ||
        job.queue !== QUEUE_NAMES.BackfillSync ||
        !isIntegerAtLeast(job.chainId, 1) ||
        (job.collectionId !== undefined &&
            !isIntegerAtLeast(job.collectionId, 1)) ||
        !isRecord(job.payload)
    )
        return null;
    const payload = job.payload;
    if (
        !isIntegerAtLeast(payload.fromBlock, 0) ||
        !isIntegerAtLeast(payload.toBlock, payload.fromBlock) ||
        payload.repairs !== undefined ||
        payload.recovery !== undefined ||
        (payload.source !== BACKFILL_SOURCE.ManualHistorical &&
            payload.source !== BACKFILL_SOURCE.BootstrapCatchup)
    )
        return null;
    return job as JobEnvelope<BackfillSyncPayload>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
    return (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= minimum
    );
}
