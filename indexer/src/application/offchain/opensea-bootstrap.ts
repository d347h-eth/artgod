import { logger } from "@artgod/shared/utils";
import {
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import { OPENSEA_COLLECTION_STATUS } from "@artgod/shared/types";
import {
    areOpenSeaBootstrapStepsTerminal,
    markOpenSeaBootstrapStepRetry,
    markOpenSeaBootstrapStepDelegatedRunning,
    markOpenSeaBootstrapStepSucceeded,
    markOpenSeaBootstrapTerminalFailure,
    type OpenSeaBootstrapStepKey,
} from "../bootstrap-opensea-steps.js";
import { getRetryDelayMs, type RetryPolicy } from "../../domain/retry.js";
import type { JobEnvelope } from "../../domain/jobs.js";
import {
    OPENSEA_BOOTSTRAP_FAILURE_MESSAGE,
    OPENSEA_JOB_ID_SCOPE,
    OPENSEA_JOB_KIND,
    OPENSEA_ORDERBOOK_RUN_KIND,
    type OpenSeaBootstrapCollectionPayload,
} from "../../domain/opensea-jobs.js";
import { QUEUE_NAMES } from "../../domain/queues.js";
import type { BootstrapStepsPort } from "../../ports/bootstrap-steps.js";
import type { CollectionRegistryPort } from "../../ports/collections.js";
import type { OpenSeaOrderbookRunsPort } from "../../ports/opensea-orderbook-runs.js";
import type { QueuePort } from "../../ports/queue.js";
import {
    type OpenSeaSyncLifecyclePort,
    type OpenSeaOrderbookSync,
} from "./opensea-orderbook-sync.js";

type BootstrapCollections = OpenSeaSyncLifecyclePort &
    Pick<
        CollectionRegistryPort,
        | "getCollection"
        | "markOpenSeaIdentityRunning"
        | "setOpenSeaStatus"
        | "markOpenSeaSnapshotStarted"
        | "markOpenSeaSnapshotCompleted"
        | "markOpenSeaReady"
    >;

export async function handleOpenSeaBootstrapJob(
    queue: Pick<QueuePort, "publish">,
    collections: BootstrapCollections,
    bootstrapSteps: BootstrapStepsPort,
    orderbookRuns: OpenSeaOrderbookRunsPort,
    sync: Pick<OpenSeaOrderbookSync, "syncCollection">,
    retryPolicy: RetryPolicy,
    delegatedHealthCheckMs: number,
    job: JobEnvelope<OpenSeaBootstrapCollectionPayload>,
): Promise<void> {
    if (areOpenSeaBootstrapStepsTerminal(bootstrapSteps, job.payload)) {
        logger.debug(
            "OpenSea bootstrap skipped; bootstrap steps are terminal",
            {
                component: "OpenSeaBootstrapWorker",
                action: "handleBootstrapJob",
                chainId: job.payload.chainId,
                collectionId: job.payload.collectionId,
                runId: job.payload.bootstrap?.runId,
            },
        );
        return;
    }

    const collection = collections.getCollection(
        job.payload.chainId,
        job.payload.collectionId,
    );
    if (!collection) {
        markOpenSeaBootstrapTerminalFailure({
            stepsPort: bootstrapSteps,
            payload: job.payload,
            activeStep: BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
            attempts: Math.max(1, job.attempt),
            error: OPENSEA_BOOTSTRAP_FAILURE_MESSAGE.CollectionMissing,
        });
        logger.warn("OpenSea bootstrap skipped; collection missing", {
            component: "OpenSeaBootstrapWorker",
            action: "handleBootstrapJob",
            chainId: job.payload.chainId,
            collectionId: job.payload.collectionId,
        });
        return;
    }

    const identity = collections.captureOpenSeaSyncIdentity(collection);
    const bootstrapRunId = job.payload.bootstrap?.runId;
    if (
        !identity ||
        (bootstrapRunId !== undefined &&
            (identity.bootstrapRunId !== bootstrapRunId ||
                bootstrapSteps.getStep(
                    bootstrapRunId,
                    BOOTSTRAP_STEP_KEY.CollectionLive,
                )?.status !== BOOTSTRAP_STEP_STATUS.Succeeded))
    )
        return;

    // CollectionLive is the durable core-completion fact. The same run may be
    // back in Metadata while explicit post-live retries settle independently.
    let runId = 0;
    if (
        !collections.commitOpenSeaSync(identity, () => {
            runId = orderbookRuns.startRun({
                chainId: collection.chainId,
                collectionId: collection.id,
                kind: OPENSEA_ORDERBOOK_RUN_KIND.Snapshot,
            });
        })
    )
        return;
    let activeStep: OpenSeaBootstrapStepKey =
        BOOTSTRAP_STEP_KEY.OpenSeaIdentity;

    try {
        if (
            !collections.commitOpenSeaSync(identity, () => {
                markOpenSeaBootstrapStepDelegatedRunning({
                    stepsPort: bootstrapSteps,
                    payload: job.payload,
                    stepKey: BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
                    healthCheckAt:
                        Date.now() + Math.max(1, delegatedHealthCheckMs),
                });
                collections.markOpenSeaIdentityRunning(
                    collection.chainId,
                    collection.id,
                );

                const slug = collection.openseaSlug;
                if (!slug) {
                    throw new Error(
                        `Collection ${collection.id} missing explicit OpenSea slug`,
                    );
                }
                markOpenSeaBootstrapStepSucceeded(
                    bootstrapSteps,
                    job.payload,
                    BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
                );

                activeStep = BOOTSTRAP_STEP_KEY.OpenSeaSnapshot;
                markOpenSeaBootstrapStepDelegatedRunning({
                    stepsPort: bootstrapSteps,
                    payload: job.payload,
                    stepKey: BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
                    healthCheckAt:
                        Date.now() + Math.max(1, delegatedHealthCheckMs),
                });
                collections.setOpenSeaStatus(
                    collection.chainId,
                    collection.id,
                    OPENSEA_COLLECTION_STATUS.Subscribing,
                );
                collections.markOpenSeaSnapshotStarted(
                    collection.chainId,
                    collection.id,
                );
            })
        )
            return;

        await sync.syncCollection(
            collection,
            OPENSEA_ORDERBOOK_RUN_KIND.Snapshot,
            runId,
        );
        if (
            !collections.commitOpenSeaSync(identity, () => {
                collections.markOpenSeaSnapshotCompleted(
                    collection.chainId,
                    collection.id,
                );
                markOpenSeaBootstrapStepSucceeded(
                    bootstrapSteps,
                    job.payload,
                    BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
                );

                activeStep = BOOTSTRAP_STEP_KEY.OpenSeaReady;
                markOpenSeaBootstrapStepDelegatedRunning({
                    stepsPort: bootstrapSteps,
                    payload: job.payload,
                    stepKey: BOOTSTRAP_STEP_KEY.OpenSeaReady,
                    healthCheckAt:
                        Date.now() + Math.max(1, delegatedHealthCheckMs),
                });
                collections.markOpenSeaReady(collection.chainId, collection.id);
                markOpenSeaBootstrapStepSucceeded(
                    bootstrapSteps,
                    job.payload,
                    BOOTSTRAP_STEP_KEY.OpenSeaReady,
                );
                orderbookRuns.completeRun(runId);
            })
        )
            return;
    } catch (error) {
        const attempts = Math.max(1, job.attempt);
        const message = String(error);
        const terminal = attempts >= Math.max(1, retryPolicy.maxAttempts);
        const delayMs = getRetryDelayMs(attempts, retryPolicy);
        if (
            !collections.commitOpenSeaSync(identity, () => {
                orderbookRuns.failRun(runId, String(error));
                collections.setOpenSeaStatus(
                    collection.chainId,
                    collection.id,
                    terminal
                        ? OPENSEA_COLLECTION_STATUS.Failed
                        : OPENSEA_COLLECTION_STATUS.Retrying,
                    message,
                );
                if (terminal) {
                    markOpenSeaBootstrapTerminalFailure({
                        stepsPort: bootstrapSteps,
                        payload: job.payload,
                        activeStep,
                        attempts,
                        error: message,
                    });
                } else {
                    markOpenSeaBootstrapStepRetry({
                        stepsPort: bootstrapSteps,
                        payload: job.payload,
                        stepKey: activeStep,
                        attempts,
                        nextAttemptAt: Date.now() + delayMs,
                        error: message,
                    });
                }
            })
        )
            return;
        if (terminal) {
            logger.warn("OpenSea bootstrap failed terminally", {
                component: "OpenSeaBootstrapWorker",
                action: "handleBootstrapJob",
                chainId: collection.chainId,
                collectionId: collection.id,
                runId: job.payload.bootstrap?.runId,
                attempts,
                error: message,
            });
            return;
        }

        await scheduleBootstrapRetry(queue, job, attempts + 1, delayMs);
        logger.warn("OpenSea bootstrap retry scheduled", {
            component: "OpenSeaBootstrapWorker",
            action: "handleBootstrapJob",
            chainId: collection.chainId,
            collectionId: collection.id,
            runId: job.payload.bootstrap?.runId,
            attempt: attempts,
            error: message,
        });
    }
}

async function scheduleBootstrapRetry(
    queue: Pick<QueuePort, "publish">,
    job: JobEnvelope<OpenSeaBootstrapCollectionPayload>,
    nextAttempt: number,
    delayMs: number,
): Promise<void> {
    const payload = job.payload;
    const scheduledAt = Date.now() + delayMs;
    const retryJob: JobEnvelope<OpenSeaBootstrapCollectionPayload> = {
        jobId: [
            OPENSEA_JOB_ID_SCOPE.BootstrapCollection,
            payload.chainId,
            payload.bootstrap?.runId ?? payload.collectionId,
            payload.collectionId,
            nextAttempt,
            scheduledAt,
        ].join(":"),
        kind: OPENSEA_JOB_KIND.BootstrapCollection,
        queue: QUEUE_NAMES.OpenSeaBootstrap,
        payload,
        attempt: nextAttempt,
        scheduledAt,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        traceId: job.traceId,
    };
    await queue.publish(QUEUE_NAMES.OpenSeaBootstrap, retryJob);
}
