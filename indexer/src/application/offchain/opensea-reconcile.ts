import { OPENSEA_COLLECTION_STATUS } from "@artgod/shared/types";
import { logger } from "@artgod/shared/utils";
import type { JobEnvelope } from "../../domain/jobs.js";
import {
    OPENSEA_JOB_ID_SCOPE,
    OPENSEA_JOB_KIND,
    OPENSEA_QUEUE_NAME,
    OPENSEA_ORDERBOOK_RUN_KIND,
    OPENSEA_RECONCILE_REASON,
    type OpenSeaReconcileCollectionPayload,
} from "../../domain/opensea-jobs.js";
import type { OpenSeaReconcilePolicy } from "../../domain/opensea-reconcile-policy.js";
import type { CollectionRegistryPort } from "../../ports/collections.js";
import type { OpenSeaOrderbookRunsPort } from "../../ports/opensea-orderbook-runs.js";
import type { QueuePort } from "../../ports/queue.js";
import type { OpenSeaOrderbookSync } from "./opensea-orderbook-sync.js";

type ReconcileCollections = Pick<
    CollectionRegistryPort,
    | "listCollectionsForOpenSeaReconcile"
    | "markOpenSeaReconcileStarted"
    | "markOpenSeaReconcileCompleted"
    | "markOpenSeaReady"
    | "setOpenSeaStatus"
>;

export async function handleReconcileJob(
    queue: Pick<QueuePort, "publish">,
    collections: ReconcileCollections,
    orderbookRuns: OpenSeaOrderbookRunsPort,
    sync: Pick<OpenSeaOrderbookSync, "syncCollection">,
    freshness: OpenSeaReconcilePolicy,
    retryPolicy: { baseDelayMs: number; maxDelayMs: number },
    job: JobEnvelope<OpenSeaReconcileCollectionPayload>,
    now: () => number = Date.now,
): Promise<void> {
    const startedAt = now();
    const context = {
        component: "OpenSeaReconcile",
        action: "handleReconcileJob",
        jobId: job.jobId,
        chainId: job.payload.chainId,
        collectionId: job.payload.collectionId,
        reason: job.payload.reason,
        attempt: job.attempt,
    };
    // Recheck after queue delay, before any run insert, observation or state write.
    // This same registry query owns scheduler selection and consumption eligibility.
    const [collection] = collections.listCollectionsForOpenSeaReconcile(
        job.payload.chainId,
        freshness.completedBeforeMs(job.payload.reason, startedAt),
        job.payload.collectionId,
    );
    if (!collection) {
        logger.debug(
            "OpenSea reconcile skipped; fresh or no longer eligible",
            context,
        );
        return;
    }

    const runId = orderbookRuns.startRun({
        chainId: collection.chainId,
        collectionId: collection.id,
        kind: OPENSEA_ORDERBOOK_RUN_KIND.Reconcile,
    });
    logger.info("OpenSea reconcile started", { ...context, runId });

    try {
        collections.markOpenSeaReconcileStarted(
            collection.chainId,
            collection.id,
        );
        const result = await sync.syncCollection(
            collection,
            OPENSEA_ORDERBOOK_RUN_KIND.Reconcile,
            runId,
        );
        orderbookRuns.completeRun(runId);
        collections.markOpenSeaReady(collection.chainId, collection.id);
        // Completion is the freshness authority. Never advance it for a failed scan.
        collections.markOpenSeaReconcileCompleted(
            collection.chainId,
            collection.id,
        );
        logger.info("OpenSea reconcile completed", {
            ...context,
            runId,
            durationMs: now() - startedAt,
            ...result,
        });
    } catch (error) {
        orderbookRuns.failRun(runId, String(error));
        collections.setOpenSeaStatus(
            collection.chainId,
            collection.id,
            OPENSEA_COLLECTION_STATUS.Retrying,
            String(error),
        );
        await queue.publish(
            OPENSEA_QUEUE_NAME.Reconcile,
            createReconcileJob(
                {
                    chainId: collection.chainId,
                    collectionId: collection.id,
                    // A failed explicit refresh must retain its force intent even if
                    // the preceding successful refresh is still within the age limit.
                    reason:
                        job.payload.reason === OPENSEA_RECONCILE_REASON.Manual
                            ? OPENSEA_RECONCILE_REASON.Manual
                            : OPENSEA_RECONCILE_REASON.Retry,
                },
                now() + getRetryDelayMs(job.attempt, retryPolicy),
            ),
        );
        logger.warn("OpenSea reconcile retry scheduled", {
            ...context,
            runId,
            durationMs: now() - startedAt,
            error: String(error),
        });
    }
}

export async function scheduleDueReconciles(
    queue: Pick<QueuePort, "publish">,
    collections: Pick<
        CollectionRegistryPort,
        "listCollectionsForOpenSeaReconcile"
    >,
    chainId: number,
    freshness: OpenSeaReconcilePolicy,
    reason:
        | typeof OPENSEA_RECONCILE_REASON.Scheduled
        | typeof OPENSEA_RECONCILE_REASON.StartupStale,
    now: number = Date.now(),
): Promise<void> {
    const due = collections.listCollectionsForOpenSeaReconcile(
        chainId,
        freshness.completedBeforeMs(reason, now),
    );
    const bucket =
        reason === OPENSEA_RECONCILE_REASON.Scheduled
            ? freshness.scheduledJobBucket(now)
            : now;
    for (const collection of due) {
        await queue.publish(
            OPENSEA_QUEUE_NAME.Reconcile,
            createReconcileJob(
                {
                    chainId,
                    collectionId: collection.id,
                    reason,
                },
                now,
                bucket,
            ),
        );
    }
}

function createReconcileJob(
    payload: OpenSeaReconcileCollectionPayload,
    scheduledAt: number,
    bucket = scheduledAt,
): JobEnvelope<OpenSeaReconcileCollectionPayload> {
    return {
        jobId: `${OPENSEA_JOB_ID_SCOPE.ReconcileCollection}:${payload.chainId}:${payload.collectionId}:${payload.reason}:${bucket}`,
        kind: OPENSEA_JOB_KIND.ReconcileCollection,
        queue: OPENSEA_QUEUE_NAME.Reconcile,
        payload,
        attempt: 0,
        scheduledAt,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
    };
}

function getRetryDelayMs(
    attempt: number,
    retryPolicy: { baseDelayMs: number; maxDelayMs: number },
): number {
    const exponent = Math.max(0, attempt - 1);
    return Math.min(
        retryPolicy.baseDelayMs * Math.pow(2, exponent),
        retryPolicy.maxDelayMs,
    );
}
