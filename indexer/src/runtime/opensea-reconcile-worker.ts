import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadOpenSeaConfig } from "../config/opensea.js";
import { runWorker } from "../application/worker-runner.js";
import { OpenSeaOrderbookSync } from "../application/offchain/opensea-orderbook-sync.js";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    OPENSEA_JOB_KIND,
    type OpenSeaReconcileCollectionPayload,
} from "../domain/opensea-jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
import { SqliteOpenSeaOrderbookRuns } from "../infra/offchain/sqlite-orderbook-runs.js";
import { SqliteOrderSourceStateStore } from "../infra/offchain/sqlite-order-source-state.js";
import { OpenSeaApiAdapter } from "../infra/offchain/opensea-api.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import { initRuntimeApm } from "@artgod/shared/observability/apm";

async function main() {
    try {
        const config = loadOpenSeaConfig();
        setDbPath(config.dbPath);
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "opensea-reconcile-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.reconcileWorker,
            worker: "opensea-reconcile-worker",
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
                queue: QUEUE_NAMES.OpenSeaReconcile,
                consumerName: `opensea-reconcile-${config.chainId}`,
                maxInFlight: 1,
            },
            async (job: JobEnvelope<OpenSeaReconcileCollectionPayload>) => {
                if (job.kind !== OPENSEA_JOB_KIND.ReconcileCollection) return;
                await handleReconcileJob(
                    queue,
                    collections,
                    orderbookRuns,
                    sync,
                    config.opensea.retryPolicy,
                    job,
                );
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.openseaReconcile.consume",
            },
        );

        logger.info("OpenSea reconcile worker ready", {
            component: "OpenSeaReconcileWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("OpenSea reconcile worker shutting down", {
                component: "OpenSeaReconcileWorker",
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
        logger.error("OpenSea reconcile worker failed", {
            component: "OpenSeaReconcileWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();

async function handleReconcileJob(
    queue: NatsJetStreamQueue,
    collections: SqliteCollectionRegistry,
    orderbookRuns: SqliteOpenSeaOrderbookRuns,
    sync: OpenSeaOrderbookSync,
    retryPolicy: {
        baseDelayMs: number;
        maxDelayMs: number;
    },
    job: JobEnvelope<OpenSeaReconcileCollectionPayload>,
): Promise<void> {
    const collection = collections.getCollection(
        job.payload.chainId,
        job.payload.collectionId,
    );
    if (!collection || !collection.openseaSlug) {
        logger.warn("OpenSea reconcile skipped; collection or slug missing", {
            component: "OpenSeaReconcileWorker",
            action: "handleReconcileJob",
            chainId: job.payload.chainId,
            collectionId: job.payload.collectionId,
        });
        return;
    }

    const runId = orderbookRuns.startRun({
        chainId: collection.chainId,
        collectionId: collection.id,
        kind: "reconcile",
    });

    try {
        collections.markOpenSeaReconcileStarted(
            collection.chainId,
            collection.id,
        );
        await sync.syncCollection(collection, "reconcile", runId);
        collections.markOpenSeaReconcileCompleted(
            collection.chainId,
            collection.id,
        );
        collections.markOpenSeaReady(collection.chainId, collection.id);
        orderbookRuns.completeRun(runId);
    } catch (error) {
        orderbookRuns.failRun(runId, String(error));
        collections.setOpenSeaStatus(
            collection.chainId,
            collection.id,
            "retrying",
            String(error),
        );
        await scheduleReconcileRetry(
            queue,
            {
                chainId: collection.chainId,
                collectionId: collection.id,
                reason: "retry",
            },
            getRetryDelayMs(job.attempt, retryPolicy),
        );
        logger.warn("OpenSea reconcile retry scheduled", {
            component: "OpenSeaReconcileWorker",
            action: "handleReconcileJob",
            chainId: collection.chainId,
            collectionId: collection.id,
            attempt: job.attempt,
            error: String(error),
        });
    }
}

async function scheduleReconcileRetry(
    queue: NatsJetStreamQueue,
    payload: OpenSeaReconcileCollectionPayload,
    delayMs: number,
): Promise<void> {
    const scheduledAt = Date.now() + delayMs;
    const retryJob: JobEnvelope<OpenSeaReconcileCollectionPayload> = {
        jobId: `opensea:reconcile:${payload.chainId}:${payload.collectionId}:retry:${scheduledAt}`,
        kind: OPENSEA_JOB_KIND.ReconcileCollection,
        queue: QUEUE_NAMES.OpenSeaReconcile,
        payload,
        attempt: 0,
        scheduledAt,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
    };
    await queue.publish(QUEUE_NAMES.OpenSeaReconcile, retryJob);
}

function getRetryDelayMs(
    attempt: number,
    retryPolicy: { baseDelayMs: number; maxDelayMs: number },
): number {
    const exponent = Math.max(0, attempt - 1);
    const delay = retryPolicy.baseDelayMs * Math.pow(2, exponent);
    return Math.min(delay, retryPolicy.maxDelayMs);
}
