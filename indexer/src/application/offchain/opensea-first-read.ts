import { logger } from "@artgod/shared/utils";
import { BOOTSTRAP_STEP_KEY } from "@artgod/shared/bootstrap/pipeline";
import type { OpenSeaOrderbookSync } from "./opensea-orderbook-sync.js";
import type { BootstrapStepsPort } from "../../ports/bootstrap-steps.js";
import type { CollectionRegistryPort } from "../../ports/collections.js";
import type { OpenSeaOrderbookRunsPort } from "../../ports/opensea-orderbook-runs.js";
import type { QueuePort } from "../../ports/queue.js";
import {
    areOpenSeaBootstrapStepsTerminal,
    markOpenSeaBootstrapStepRetry,
    markOpenSeaBootstrapStepDelegatedRunning,
    markOpenSeaBootstrapStepSucceeded,
    markOpenSeaBootstrapTerminalFailure,
    type OpenSeaBootstrapStepKey,
} from "../bootstrap-opensea-steps.js";
import { getRetryDelayMs, type RetryPolicy } from "../../domain/retry.js";
import { OPENSEA_COLLECTION_STATUS } from "@artgod/shared/types";
import type { JobEnvelope } from "../../domain/jobs.js";
import {
    OPENSEA_BOOTSTRAP_FAILURE_MESSAGE,
    OPENSEA_JOB_ID_SCOPE,
    OPENSEA_JOB_KIND,
    type OpenSeaBootstrapCollectionPayload,
} from "../../domain/opensea-jobs.js";
import { QUEUE_NAMES } from "../../domain/queues.js";

export async function handleOpenSeaFirstRead(
    queue: Pick<QueuePort, "publish">,
    collections: CollectionRegistryPort,
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
                component: "OpenSeaFirstRead",
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
            component: "OpenSeaFirstRead",
            action: "handleBootstrapJob",
            chainId: job.payload.chainId,
            collectionId: job.payload.collectionId,
        });
        return;
    }

    const runId = orderbookRuns.startRun({
        chainId: collection.chainId,
        collectionId: collection.id,
        kind: "snapshot",
    });
    let activeStep: OpenSeaBootstrapStepKey =
        BOOTSTRAP_STEP_KEY.OpenSeaIdentity;

    try {
        markOpenSeaBootstrapStepDelegatedRunning({
            stepsPort: bootstrapSteps,
            payload: job.payload,
            stepKey: BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
            healthCheckAt: Date.now() + Math.max(1, delegatedHealthCheckMs),
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
            healthCheckAt: Date.now() + Math.max(1, delegatedHealthCheckMs),
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

        await sync.syncCollection(collection, "snapshot", runId);

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
            healthCheckAt: Date.now() + Math.max(1, delegatedHealthCheckMs),
        });
        collections.markOpenSeaReady(collection.chainId, collection.id);
        markOpenSeaBootstrapStepSucceeded(
            bootstrapSteps,
            job.payload,
            BOOTSTRAP_STEP_KEY.OpenSeaReady,
        );
        orderbookRuns.completeRun(runId);
    } catch (error) {
        const attempts = Math.max(1, job.attempt);
        const message = String(error);
        const terminal = attempts >= Math.max(1, retryPolicy.maxAttempts);
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
            logger.warn("OpenSea bootstrap failed terminally", {
                component: "OpenSeaFirstRead",
                action: "handleBootstrapJob",
                chainId: collection.chainId,
                collectionId: collection.id,
                runId: job.payload.bootstrap?.runId,
                attempts,
                error: message,
            });
            return;
        }

        const delayMs = getRetryDelayMs(attempts, retryPolicy);
        markOpenSeaBootstrapStepRetry({
            stepsPort: bootstrapSteps,
            payload: job.payload,
            stepKey: activeStep,
            attempts,
            nextAttemptAt: Date.now() + delayMs,
            error: message,
        });
        await scheduleBootstrapRetry(queue, job, attempts + 1, delayMs);
        logger.warn("OpenSea bootstrap retry scheduled", {
            component: "OpenSeaFirstRead",
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
        queue: QUEUE_NAMES.OpenSeaReconcile,
        payload,
        attempt: nextAttempt,
        scheduledAt,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        traceId: job.traceId,
    };
    await queue.publish(QUEUE_NAMES.OpenSeaReconcile, retryJob);
}
