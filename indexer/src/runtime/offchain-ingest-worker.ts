import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { runWorker } from "../application/worker-runner.js";
import { dispatchOffchainPayload } from "../application/offchain/dispatch.js";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    OFFCHAIN_JOB_KIND,
    type OffchainOrderRawPayload,
} from "../domain/offchain-jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { SqliteOffchainObservationStore } from "../infra/offchain/sqlite-observations.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { SqliteTokenSetRegistry } from "../infra/token-sets/sqlite.js";
import { initRuntimeMetrics } from "../metrics/runtime.js";
import { initRuntimeApm } from "../observability/apm.js";

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
        const tokenSets = new SqliteTokenSetRegistry();
        const observations = new SqliteOffchainObservationStore();

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

                const result = await dispatchOffchainPayload(
                    queue,
                    tokenSets,
                    job.payload,
                );
                if (result.handled) return;

                logger.debug("Offchain payload ignored", {
                    component: "OffchainIngestWorker",
                    action: "consume",
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
            component: "OffchainIngestWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Offchain ingest worker shutting down", {
                component: "OffchainIngestWorker",
                action: "shutdown",
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
            component: "OffchainIngestWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();
