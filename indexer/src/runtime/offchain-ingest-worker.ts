import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { runWorker } from "../application/worker-runner.js";
import { dispatchOffchainPayload } from "../application/offchain/dispatch.js";
import { shouldProcessOffchainPayload } from "../application/offchain/ingestion-gate.js";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    OFFCHAIN_JOB_KIND,
    type OffchainOrderRawPayload,
} from "../domain/offchain-jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
import { SqliteOffchainObservationStore } from "../infra/offchain/sqlite-observations.js";
import { SqliteOrderActivityLookup } from "../infra/offchain/sqlite-order-activity-lookup.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { SqliteTokenSetRegistry } from "../infra/token-sets/sqlite.js";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import { initRuntimeApm } from "@artgod/shared/observability/apm";

const OFFCHAIN_INGEST_WORKER_COMPONENT = "OffchainIngestWorker";
const OFFCHAIN_INGEST_WORKER_ACTION = {
    Main: "main",
    Consume: "consume",
    Shutdown: "shutdown",
} as const;

async function main() {
    try {
        const config = loadConfig();
        setDbPath(config.dbPath);
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "offchain-ingest-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.offchainIngestWorker,
            worker: "offchain-ingest-worker",
            chainId: config.chainId,
        });
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const collections = new SqliteCollectionRegistry();
        const tokenSets = new SqliteTokenSetRegistry();
        const observations = new SqliteOffchainObservationStore();
        const orderActivityLookup = new SqliteOrderActivityLookup();

        const stopIngest = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OffchainOrdersRaw,
                consumerName: `offchain-ingest-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<OffchainOrderRawPayload>) => {
                if (job.kind !== OFFCHAIN_JOB_KIND.OrderRaw) return;
                if (!shouldProcessOffchainPayload(collections, job.payload)) {
                    logger.info("Offchain payload skipped by collection gate", {
                        component: OFFCHAIN_INGEST_WORKER_COMPONENT,
                        action: OFFCHAIN_INGEST_WORKER_ACTION.Consume,
                        chainId: job.payload.chainId,
                        collectionId: job.payload.collectionId,
                        source: job.payload.source,
                        channel: job.payload.channel,
                        eventType: job.payload.eventType,
                    });
                    return;
                }

                if (config.offchain.persistRawObservations) {
                    observations.recordObservation({
                        chainId: job.payload.chainId,
                        collectionId: job.payload.collectionId,
                        source: job.payload.source,
                        channel: job.payload.channel,
                        dedupeKey: job.payload.dedupeKey,
                        eventType: job.payload.eventType,
                        orderId: job.payload.orderId ?? null,
                        runId: job.payload.runId ?? null,
                        receivedAt: job.payload.receivedAt,
                        sourceEventAt: job.payload.sourceEventAt ?? null,
                        payload: job.payload.payload,
                    });
                }

                const result = await dispatchOffchainPayload(
                    queue,
                    tokenSets,
                    orderActivityLookup,
                    job.payload,
                );
                if (result.handled) return;

                logger.debug("Offchain payload ignored", {
                    component: OFFCHAIN_INGEST_WORKER_COMPONENT,
                    action: OFFCHAIN_INGEST_WORKER_ACTION.Consume,
                    chainId: job.payload.chainId,
                    collectionId: job.payload.collectionId,
                    source: job.payload.source,
                    eventType: job.payload.eventType,
                });
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.offchainIngest.consume",
            },
        );

        logger.info("Offchain ingest worker ready", {
            component: OFFCHAIN_INGEST_WORKER_COMPONENT,
            action: OFFCHAIN_INGEST_WORKER_ACTION.Main,
            persistRawObservations: config.offchain.persistRawObservations,
        });

        const shutdown = async () => {
            logger.info("Offchain ingest worker shutting down", {
                component: OFFCHAIN_INGEST_WORKER_COMPONENT,
                action: OFFCHAIN_INGEST_WORKER_ACTION.Shutdown,
            });
            await stopIngest();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    } catch (error) {
        logger.error("Offchain ingest worker startup failed", {
            component: OFFCHAIN_INGEST_WORKER_COMPONENT,
            action: OFFCHAIN_INGEST_WORKER_ACTION.Main,
            error: String(error),
        });
        process.exit(1);
    }
}

main();
