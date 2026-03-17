import type { MetadataStatsRecomputePayload } from "../../domain/domain-jobs.js";
import { DOMAIN_JOB_KIND } from "../../domain/domain-jobs.js";
import type { JobEnvelope } from "../../domain/jobs.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import type { QueuePort } from "../../ports/queue.js";

export const METADATA_STATS_DEDUPE_BUCKET_MS = 10_000;

export function buildMetadataStatsRecomputeJob(
    payload: MetadataStatsRecomputePayload,
    traceId: string,
    now: number = Date.now(),
): JobEnvelope<MetadataStatsRecomputePayload> {
    const bucketStart =
        Math.floor(now / METADATA_STATS_DEDUPE_BUCKET_MS) *
        METADATA_STATS_DEDUPE_BUCKET_MS;

    // Trailing-edge debounce: schedule recompute at bucket end so one job
    // captures all metadata changes that arrived during the full bucket window.
    const scheduledAt = bucketStart + METADATA_STATS_DEDUPE_BUCKET_MS;

    return {
        jobId: `metadata:stats:${payload.chainId}:${payload.collectionId}:${payload.reason}:${bucketStart}`,
        kind: DOMAIN_JOB_KIND.MetadataStatsRecompute,
        queue: QUEUE_NAMES.MetadataStats,
        payload,
        attempt: 0,
        scheduledAt,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        traceId,
    };
}

export async function publishMetadataStatsRecompute(
    queue: QueuePort,
    payload: MetadataStatsRecomputePayload,
    traceId: string,
    now?: number,
): Promise<void> {
    const job = buildMetadataStatsRecomputeJob(payload, traceId, now);
    await queue.publish(QUEUE_NAMES.MetadataStats, job);
}
