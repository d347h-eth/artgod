import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { zeroAddress } from "viem";
import { loadOpenSeaConfig } from "../config/opensea.js";
import { OPENSEA_RECONCILE_WORKER_POLICY } from "../config/opensea-reconcile-worker.js";
import { SqliteDailyListingPrices } from "../infra/storage/sqlite-daily-listing-prices.js";
import { runWorker } from "../application/worker-runner.js";
import { handleReconcileJob } from "../application/offchain/opensea-reconcile.js";
import { OpenSeaReconcilePolicy } from "../domain/opensea-reconcile-policy.js";
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
        const sourceState = new SqliteOrderSourceStateStore(
            new SqliteDailyListingPrices(db, [
                zeroAddress,
                config.tokens.wethAddress,
            ]),
        );
        const api = new OpenSeaApiAdapter({
            apiKey: config.opensea.apiKey,
            snapshotPageSize: config.opensea.snapshotPageSize,
            retryPolicy: config.opensea.retryPolicy,
            rateLimiter: config.opensea.rateLimiter,
        });
        const sync = new OpenSeaOrderbookSync(api, queue, sourceState);
        const freshness = new OpenSeaReconcilePolicy(config.opensea);

        const stopWorker = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OpenSeaReconcile,
                consumerName: `opensea-reconcile-${config.chainId}`,
                ...OPENSEA_RECONCILE_WORKER_POLICY,
            },
            async (job: JobEnvelope<OpenSeaReconcileCollectionPayload>) => {
                if (job.kind !== OPENSEA_JOB_KIND.ReconcileCollection) return;
                await handleReconcileJob(
                    queue,
                    collections,
                    orderbookRuns,
                    sync,
                    freshness,
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
