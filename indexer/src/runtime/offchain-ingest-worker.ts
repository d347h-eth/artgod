import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { runWorker } from "../application/worker-runner.js";
import { normalizeOffchainOrder } from "../application/offchain/normalize.js";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    OFFCHAIN_JOB_KIND,
    type OffchainOrderRawPayload,
} from "../domain/offchain-jobs.js";
import {
    ORDER_JOB_KIND,
    type OrderUpsertPayload,
} from "../domain/order-jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";

async function main() {
    try {
        const config = loadConfig();
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });

        // Convert raw offchain payloads into normalized order upserts.
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
                const normalized = normalizeOffchainOrder(job.payload);
                if (!normalized) {
                    // Unsupported offchain event types are ignored (no retry).
                    logger.debug("Offchain order ignored", {
                        component: "OffchainIngestWorker",
                        action: "normalize",
                        source: job.payload.source,
                        chainId: job.payload.chainId,
                    });
                    return;
                }
                const upsertJob: JobEnvelope<OrderUpsertPayload> = {
                    jobId: `orders:upsert:${normalized.chainId}:${normalized.orderId}:${job.payload.receivedAt}`,
                    kind: ORDER_JOB_KIND.Upsert,
                    queue: QUEUE_NAMES.OrdersUpsert,
                    payload: {
                        ...normalized,
                        validateAfterUpsert: true,
                    },
                    attempt: 0,
                    scheduledAt: Date.now(),
                    chainId: normalized.chainId,
                };
                await queue.publish(QUEUE_NAMES.OrdersUpsert, upsertJob);

                logger.debug("Offchain order normalized", {
                    component: "OffchainIngestWorker",
                    action: "normalize",
                    source: normalized.source,
                    orderId: normalized.orderId,
                    chainId: normalized.chainId,
                });
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
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        process.stdin.resume();
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
