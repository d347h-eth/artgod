import { scheduleVvvBooks } from "../application/offchain/vvv-reconcile.js";
import { runWorker } from "../application/worker-runner.js";
import { ORDERBOOK_COLLECTION_LIVE_JOB } from "../domain/orderbook.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { VVV_MARKETS } from "../infra/offchain/vvv-markets.js";
import { SqliteOrderSourceStateStore } from "../infra/offchain/sqlite-order-source-state.js";
import { ORDERBOOK_SCHEDULER_POLL_MS } from "../config/orderbook-reconcile-worker.js";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadOrderbookConfig } from "../config/opensea.js";
import { OPENSEA_RECONCILE_REASON } from "../domain/opensea-jobs.js";
import { OpenSeaReconcilePolicy } from "../domain/opensea-reconcile-policy.js";
import { scheduleDueReconciles } from "../application/offchain/opensea-reconcile.js";
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import { initRuntimeApm } from "@artgod/shared/observability/apm";

async function main() {
    try {
        const config = loadOrderbookConfig();
        setDbPath(config.dbPath);
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "orderbook-reconcile-scheduler-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.reconcileSchedulerWorker,
            worker: "orderbook-reconcile-scheduler-worker",
            chainId: config.chainId,
        });
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const collections = new SqliteCollectionRegistry();
        const books = new SqliteOrderSourceStateStore(
            config.tokens.wethAddress,
        );
        const provider = config.opensea;
        const markets = VVV_MARKETS.map(({ market }) => market);
        const scheduleVvv = (collectionId?: number) =>
            scheduleVvvBooks(books, queue, config.chainId, markets, {
                collectionId,
            });
        const freshness = provider
            ? new OpenSeaReconcilePolicy(provider)
            : null;
        async function tick(
            reason:
                | typeof OPENSEA_RECONCILE_REASON.Scheduled
                | typeof OPENSEA_RECONCILE_REASON.StartupStale,
        ) {
            await Promise.all([
                scheduleVvv(),
                freshness &&
                    scheduleDueReconciles(
                        queue,
                        collections,
                        config.chainId,
                        freshness,
                        reason,
                    ),
            ]);
        }
        const stopNotifications = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OrderbookSchedule,
                consumerName:
                    QUEUE_NAMES.OrderbookSchedule + "-" + config.chainId,
                maxInFlight: 1,
            },
            async (job) => {
                if (
                    job.kind === ORDERBOOK_COLLECTION_LIVE_JOB &&
                    job.chainId === config.chainId &&
                    job.collectionId !== undefined &&
                    Number.isSafeInteger(job.collectionId) &&
                    job.collectionId > 0
                )
                    await scheduleVvv(job.collectionId);
            },
        );
        await tick(OPENSEA_RECONCILE_REASON.StartupStale);
        const timer = setInterval(
            () => {
                tick(OPENSEA_RECONCILE_REASON.Scheduled).catch((error) =>
                    logger.warn("Orderbook scheduling failed", {
                        component: "OrderbookReconcileSchedulerWorker",
                        action: "tick",
                        error: String(error),
                    }),
                );
            },
            Math.min(
                provider?.reconcileIntervalMs ?? ORDERBOOK_SCHEDULER_POLL_MS,
                ORDERBOOK_SCHEDULER_POLL_MS,
            ),
        );

        logger.info("Orderbook reconcile scheduler worker ready", {
            component: "OrderbookReconcileSchedulerWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Orderbook reconcile scheduler worker shutting down", {
                component: "OrderbookReconcileSchedulerWorker",
                action: "shutdown",
            });
            clearInterval(timer);
            await stopNotifications();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    } catch (error) {
        logger.error("Orderbook reconcile scheduler worker failed", {
            component: "OrderbookReconcileSchedulerWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();
