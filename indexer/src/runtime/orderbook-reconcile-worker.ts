import { handleOpenSeaFirstRead } from "../application/offchain/opensea-first-read.js";
import { SqliteBootstrapSteps } from "../infra/bootstrap/sqlite-steps.js";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { zeroAddress } from "viem";
import { loadOrderbookConfig } from "../config/opensea.js";
import { ORDERBOOK_RECONCILE_WORKER_POLICY } from "../config/orderbook-reconcile-worker.js";
import { SqliteDailyListingPrices } from "../infra/storage/sqlite-daily-listing-prices.js";
import { runWorker } from "../application/worker-runner.js";
import { handleReconcileJob } from "../application/offchain/opensea-reconcile.js";
import { OpenSeaReconcilePolicy } from "../domain/opensea-reconcile-policy.js";
import { OpenSeaOrderbookSync } from "../application/offchain/opensea-orderbook-sync.js";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    OPENSEA_JOB_KIND,
    type OpenSeaReconcileCollectionPayload,
    type OpenSeaBootstrapCollectionPayload,
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
        const config = loadOrderbookConfig();
        setDbPath(config.dbPath);
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "orderbook-reconcile-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.reconcileWorker,
            worker: "orderbook-reconcile-worker",
            chainId: config.chainId,
        });
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const provider = config.opensea;
        const stopWorker = provider
            ? await startOpenSeaConsumer(provider)
            : undefined;

        async function startOpenSeaConsumer(
            provider: NonNullable<typeof config.opensea>,
        ) {
            const steps = new SqliteBootstrapSteps();
            const collections = new SqliteCollectionRegistry();
            const orderbookRuns = new SqliteOpenSeaOrderbookRuns();
            const sourceState = new SqliteOrderSourceStateStore(
                new SqliteDailyListingPrices(db, [
                    zeroAddress,
                    config.tokens.wethAddress,
                ]),
            );
            const api = new OpenSeaApiAdapter({
                apiKey: provider.apiKey,
                snapshotPageSize: provider.snapshotPageSize,
                retryPolicy: provider.retryPolicy,
                rateLimiter: provider.rateLimiter,
            });
            const sync = new OpenSeaOrderbookSync(api, queue, sourceState);
            const freshness = new OpenSeaReconcilePolicy(provider);

            return runWorker(
                queue,
                {
                    queue: QUEUE_NAMES.OpenSeaReconcile,
                    consumerName: `orderbook-opensea-${config.chainId}`,
                    ...ORDERBOOK_RECONCILE_WORKER_POLICY,
                },
                async (
                    job: JobEnvelope<
                        | OpenSeaReconcileCollectionPayload
                        | OpenSeaBootstrapCollectionPayload
                    >,
                ) => {
                    if (job.kind === OPENSEA_JOB_KIND.BootstrapCollection) {
                        return handleOpenSeaFirstRead(
                            queue,
                            collections,
                            steps,
                            orderbookRuns,
                            sync,
                            provider.retryPolicy,
                            provider.staleStartThresholdMs,
                            job as JobEnvelope<OpenSeaBootstrapCollectionPayload>,
                        );
                    }
                    if (job.kind !== OPENSEA_JOB_KIND.ReconcileCollection)
                        return;
                    await handleReconcileJob(
                        queue,
                        collections,
                        orderbookRuns,
                        sync,
                        freshness,
                        provider.retryPolicy,
                        job as JobEnvelope<OpenSeaReconcileCollectionPayload>,
                    );
                },
                {
                    apm: runtimeApm.apm,
                    spanName: "worker.orderbook.opensea.consume",
                },
            );
        }

        logger.info("Orderbook reconcile worker ready", {
            component: "OrderbookReconcileWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Orderbook reconcile worker shutting down", {
                component: "OrderbookReconcileWorker",
                action: "shutdown",
            });
            await stopWorker?.();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    } catch (error) {
        logger.error("Orderbook reconcile worker failed", {
            component: "OrderbookReconcileWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();
