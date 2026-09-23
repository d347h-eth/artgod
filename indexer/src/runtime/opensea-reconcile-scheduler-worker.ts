import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadOpenSeaConfig } from "../config/opensea.js";
import { OPENSEA_RECONCILE_REASON } from "../domain/opensea-jobs.js";
import { OpenSeaReconcilePolicy } from "../domain/opensea-reconcile-policy.js";
import { scheduleDueReconciles } from "../application/offchain/opensea-reconcile.js";
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
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
        const freshness = new OpenSeaReconcilePolicy(config.opensea);

        await scheduleDueReconciles(
            queue,
            collections,
            config.chainId,
            freshness,
            OPENSEA_RECONCILE_REASON.StartupStale,
        );

        const timer = setInterval(() => {
            scheduleDueReconciles(
                queue,
                collections,
                config.chainId,
                freshness,
                OPENSEA_RECONCILE_REASON.Scheduled,
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
