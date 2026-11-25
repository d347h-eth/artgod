import { ORDERBOOK_VENUE } from "@artgod/shared/market-data/orders";
import { VVV_READ_JOB, type BoundMarketJob } from "../domain/orderbook.js";
import { VvvBrowserBookReader } from "../infra/offchain/vvv-browser.js";
import { reconcileVvvBook } from "../application/offchain/vvv-reconcile.js";
import { handleOpenSeaFirstRead } from "../application/offchain/opensea-first-read.js";
import { SqliteBootstrapSteps } from "../infra/bootstrap/sqlite-steps.js";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadOrderbookConfig } from "../config/opensea.js";
import { ORDERBOOK_RECONCILE_WORKER_POLICY } from "../config/orderbook-reconcile-worker.js";
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
        const sourceState = new SqliteOrderSourceStateStore(
            config.tokens.wethAddress,
        );
        const reader = new VvvBrowserBookReader();
        const stopVvv = await runWorker<BoundMarketJob>(
            queue,
            {
                queue: QUEUE_NAMES.VvvReconcile,
                consumerName: QUEUE_NAMES.VvvReconcile + "-" + config.chainId,
                ...ORDERBOOK_RECONCILE_WORKER_POLICY,
            },
            async (job) => {
                if (job.kind !== VVV_READ_JOB || job.chainId !== config.chainId)
                    return;
                try {
                    await reconcileVvvBook(
                        sourceState,
                        reader,
                        config.chainId,
                        job.payload,
                    );
                } catch (error) {
                    // The scheduler retries a failed public read at its normal cadence.
                    logger.warn("VVV book read failed", {
                        component: "OrderbookReconcileWorker",
                        feedId: job.payload.feedId,
                        error: String(error),
                    });
                }
            },
            { apm: runtimeApm.apm, spanName: "worker.orderbook.vvv.consume" },
        );
        const releaseUnusedBrowser = setInterval(() => {
            if (!sourceState.hasBindings(ORDERBOOK_VENUE.Vvv, config.chainId))
                void reader
                    .close()
                    .catch((error) =>
                        logger.warn("VVV browser close failed", {
                            error: String(error),
                        }),
                    );
        }, 30_000);
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
            const api = new OpenSeaApiAdapter({
                apiKey: provider.apiKey,
                snapshotPageSize: provider.snapshotPageSize,
                retryPolicy: provider.retryPolicy,
                rateLimiter: provider.rateLimiter,
            });
            const sync = new OpenSeaOrderbookSync(
                api,
                sourceState,
                (collection) => collections.listOpenSeaMarketScopes(collection),
            );
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
            clearInterval(releaseUnusedBrowser);
            await reader.close();
            await Promise.all([stopWorker?.(), stopVvv()]);
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
