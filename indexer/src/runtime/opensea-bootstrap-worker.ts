import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadOpenSeaConfig } from "../config/opensea.js";
import { SqliteOrdersDomain } from "../infra/domain/orders.js";
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
import { SqliteBootstrapSteps } from "../infra/bootstrap/sqlite-steps.js";
import { OpenSeaApiAdapter } from "../infra/offchain/opensea-api.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import { initRuntimeApm } from "@artgod/shared/observability/apm";
import { handleOpenSeaBootstrapJob } from "../application/offchain/opensea-bootstrap.js";

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
        const sourceState = new SqliteOrderSourceStateStore(
            new SqliteOrdersDomain(config.tokens.wethAddress),
        );
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
                await handleOpenSeaBootstrapJob(
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
