import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { BOOTSTRAP_STEP_KEY } from "@artgod/shared/bootstrap/pipeline";
import { loadOpenSeaConfig } from "../config/opensea.js";
import { runWorker } from "../application/worker-runner.js";
import { OpenSeaOrderbookSync } from "../application/offchain/opensea-orderbook-sync.js";
import {
    areOpenSeaBootstrapStepsTerminal,
    markOpenSeaBootstrapStepRetry,
    markOpenSeaBootstrapStepDelegatedRunning,
    markOpenSeaBootstrapStepSucceeded,
    markOpenSeaBootstrapTerminalFailure,
    type OpenSeaBootstrapStepKey,
} from "../application/bootstrap-opensea-steps.js";
import { getRetryDelayMs, type RetryPolicy } from "../domain/retry.js";
import { OPENSEA_COLLECTION_STATUS } from "../domain/collections.js";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    OPENSEA_BOOTSTRAP_FAILURE_MESSAGE,
    OPENSEA_JOB_ID_SCOPE,
    OPENSEA_JOB_KIND,
    type OpenSeaBootstrapCollectionPayload,
} from "../domain/opensea-jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
import { SqliteOpenSeaOrderbookRuns } from "../infra/offchain/sqlite-orderbook-runs.js";
import { SqliteOrderSourceStateStore } from "../infra/offchain/sqlite-order-source-state.js";
import { SqliteBootstrapSteps } from "../infra/bootstrap/sqlite-steps.js";
import { OpenSeaApiAdapter } from "../infra/offchain/opensea-api.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import { initRuntimeApm } from "@artgod/shared/observability/apm";
import type { BootstrapStepsPort } from "../ports/bootstrap-steps.js";

async function main() {
    try {
        const config = loadOpenSeaConfig();
        setDbPath(config.dbPath);
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "opensea-bootstrap-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.bootstrapWorker,
            worker: "opensea-bootstrap-worker",
            chainId: config.chainId,
        });
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const collections = new SqliteCollectionRegistry();
        const orderbookRuns = new SqliteOpenSeaOrderbookRuns();
        const sourceState = new SqliteOrderSourceStateStore();
        const bootstrapSteps = new SqliteBootstrapSteps();
        const api = new OpenSeaApiAdapter({
            apiKey: config.opensea.apiKey,
            snapshotPageSize: config.opensea.snapshotPageSize,
            retryPolicy: config.opensea.retryPolicy,
            rateLimiter: config.opensea.rateLimiter,
        });
        const sync = new OpenSeaOrderbookSync(api, queue, sourceState);

        const stopWorker = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OpenSeaBootstrap,
                consumerName: `opensea-bootstrap-${config.chainId}`,
                maxInFlight: 1,
            },
            async (job: JobEnvelope<OpenSeaBootstrapCollectionPayload>) => {
                if (job.kind !== OPENSEA_JOB_KIND.BootstrapCollection) return;
                await handleBootstrapJob(
                    queue,
                    collections,
                    bootstrapSteps,
                    orderbookRuns,
                    sync,
                    config.opensea.retryPolicy,
                    config.opensea.staleStartThresholdMs,
                    job,
                );
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.openseaBootstrap.consume",
            },
        );

        logger.info("OpenSea bootstrap worker ready", {
            component: "OpenSeaBootstrapWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("OpenSea bootstrap worker shutting down", {
                component: "OpenSeaBootstrapWorker",
                action: "shutdown",
            });
            await stopWorker();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    } catch (error) {
        logger.error("OpenSea bootstrap worker failed", {
            component: "OpenSeaBootstrapWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();

async function handleBootstrapJob(
    queue: NatsJetStreamQueue,
    collections: SqliteCollectionRegistry,
    bootstrapSteps: BootstrapStepsPort,
    orderbookRuns: SqliteOpenSeaOrderbookRuns,
    sync: OpenSeaOrderbookSync,
    retryPolicy: RetryPolicy,
    delegatedHealthCheckMs: number,
    job: JobEnvelope<OpenSeaBootstrapCollectionPayload>,
): Promise<void> {
    if (areOpenSeaBootstrapStepsTerminal(bootstrapSteps, job.payload)) {
        logger.debug("OpenSea bootstrap skipped; bootstrap steps are terminal", {
            component: "OpenSeaBootstrapWorker",
            action: "handleBootstrapJob",
            chainId: job.payload.chainId,
            collectionId: job.payload.collectionId,
            runId: job.payload.bootstrap?.runId,
        });
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

    const runId = orderbookRuns.startRun({
        chainId: collection.chainId,
        collectionId: collection.id,
        kind: "snapshot",
    });
    let activeStep: OpenSeaBootstrapStepKey = BOOTSTRAP_STEP_KEY.OpenSeaIdentity;

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
    queue: NatsJetStreamQueue,
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
