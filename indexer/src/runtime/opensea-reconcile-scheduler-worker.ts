import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadOpenSeaConfig } from "../config/opensea.js";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    OPENSEA_JOB_KIND,
    type OpenSeaReconcileCollectionPayload,
} from "../domain/opensea-jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
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
            worker: "opensea-reconcile-scheduler-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.reconcileSchedulerWorker,
            worker: "opensea-reconcile-scheduler-worker",
            chainId: config.chainId,
        });
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const collections = new SqliteCollectionRegistry();

        await scheduleDueReconciles(
            queue,
            collections,
            config.chainId,
            config.opensea.staleStartThresholdMs,
            "startup-stale",
        );

        const timer = setInterval(() => {
            scheduleDueReconciles(
                queue,
                collections,
                config.chainId,
                config.opensea.reconcileIntervalMs,
                "scheduled",
            ).catch((error) => {
                logger.warn("OpenSea reconcile scheduling failed", {
                    component: "OpenSeaReconcileSchedulerWorker",
                    action: "tick",
                    error: String(error),
                });
            });
        }, config.opensea.reconcileIntervalMs);

        logger.info("OpenSea reconcile scheduler worker ready", {
            component: "OpenSeaReconcileSchedulerWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("OpenSea reconcile scheduler worker shutting down", {
                component: "OpenSeaReconcileSchedulerWorker",
                action: "shutdown",
            });
            clearInterval(timer);
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        process.stdin.resume();
    } catch (error) {
        logger.error("OpenSea reconcile scheduler worker failed", {
            component: "OpenSeaReconcileSchedulerWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();

async function scheduleDueReconciles(
    queue: NatsJetStreamQueue,
    collections: SqliteCollectionRegistry,
    chainId: number,
    staleThresholdMs: number,
    reason: OpenSeaReconcileCollectionPayload["reason"],
): Promise<void> {
    const staleBeforeIso = new Date(
        Date.now() - staleThresholdMs,
    ).toISOString();
    const dueCollections = collections.listCollectionsForOpenSeaReconcile(
        chainId,
        staleBeforeIso,
    );

    for (const collection of dueCollections) {
        const bucket =
            reason === "scheduled"
                ? Math.floor(Date.now() / Math.max(staleThresholdMs, 1))
                : Date.now();
        const job: JobEnvelope<OpenSeaReconcileCollectionPayload> = {
            jobId: `opensea:reconcile:${chainId}:${collection.id}:${reason}:${bucket}`,
            kind: OPENSEA_JOB_KIND.ReconcileCollection,
            queue: QUEUE_NAMES.OpenSeaReconcile,
            payload: {
                chainId,
                collectionId: collection.id,
                reason,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
            collectionId: collection.id,
        };
        await queue.publish(QUEUE_NAMES.OpenSeaReconcile, job);
    }
}
