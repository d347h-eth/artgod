import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadOpenSeaConfig } from "../config/opensea.js";
import { runWorker } from "../application/worker-runner.js";
import { OpenSeaOrderbookSync } from "../application/offchain/opensea-orderbook-sync.js";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    OPENSEA_JOB_KIND,
    type OpenSeaBootstrapCollectionPayload,
} from "../domain/opensea-jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
import { SqliteOpenSeaOrderbookRuns } from "../infra/offchain/sqlite-orderbook-runs.js";
import { SqliteOrderSourceStateStore } from "../infra/offchain/sqlite-order-source-state.js";
import { OpenSeaApiAdapter } from "../infra/offchain/opensea-api.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { initRuntimeMetrics } from "../metrics/runtime.js";
import { initRuntimeApm } from "../observability/apm.js";

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
                    api,
                    orderbookRuns,
                    sync,
                    config.opensea.retryPolicy,
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
    api: OpenSeaApiAdapter,
    orderbookRuns: SqliteOpenSeaOrderbookRuns,
    sync: OpenSeaOrderbookSync,
    retryPolicy: {
        baseDelayMs: number;
        maxDelayMs: number;
    },
    job: JobEnvelope<OpenSeaBootstrapCollectionPayload>,
): Promise<void> {
    const collection = collections.getCollection(
        job.payload.chainId,
        job.payload.collectionId,
    );
    if (!collection) {
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

    try {
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

        collections.setOpenSeaStatus(
            collection.chainId,
            collection.id,
            "subscribing",
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
        await scheduleBootstrapRetry(
            queue,
            job.payload,
            getRetryDelayMs(job.attempt, retryPolicy),
        );
        logger.warn("OpenSea bootstrap retry scheduled", {
            component: "OpenSeaBootstrapWorker",
            action: "handleBootstrapJob",
            chainId: collection.chainId,
            collectionId: collection.id,
            attempt: job.attempt,
            error: String(error),
        });
    }
}

async function scheduleBootstrapRetry(
    queue: NatsJetStreamQueue,
    payload: OpenSeaBootstrapCollectionPayload,
    delayMs: number,
): Promise<void> {
    const scheduledAt = Date.now() + delayMs;
    const retryJob: JobEnvelope<OpenSeaBootstrapCollectionPayload> = {
        jobId: `opensea:bootstrap:${payload.chainId}:${payload.collectionId}:${scheduledAt}`,
        kind: OPENSEA_JOB_KIND.BootstrapCollection,
        queue: QUEUE_NAMES.OpenSeaBootstrap,
        payload,
        attempt: 0,
        scheduledAt,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
    };
    await queue.publish(QUEUE_NAMES.OpenSeaBootstrap, retryJob);
}

function getRetryDelayMs(
    attempt: number,
    retryPolicy: { baseDelayMs: number; maxDelayMs: number },
): number {
    const exponent = Math.max(0, attempt - 1);
    const delay = retryPolicy.baseDelayMs * Math.pow(2, exponent);
    return Math.min(delay, retryPolicy.maxDelayMs);
}
