import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { runWorker } from "../application/worker-runner.js";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    BOOTSTRAP_JOB_KIND,
    type BootstrapCollectionPayload,
} from "../domain/bootstrap-jobs.js";
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

        const stop = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.CollectionBootstrap,
                consumerName: `collection-bootstrap-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<BootstrapCollectionPayload>) => {
                if (job.kind !== BOOTSTRAP_JOB_KIND.Start) return;
                await handleBootstrapStart(job.payload);
            },
        );

        logger.info("Collection bootstrap worker ready", {
            component: "CollectionBootstrapWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Collection bootstrap worker shutting down", {
                component: "CollectionBootstrapWorker",
                action: "shutdown",
            });
            await stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        process.stdin.resume();
    } catch (error) {
        logger.error("Collection bootstrap worker startup failed", {
            component: "CollectionBootstrapWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();

async function handleBootstrapStart(
    payload: BootstrapCollectionPayload,
): Promise<void> {
    // Bootstrap orchestration entrypoint: validate scope before snapshot/backfill steps.
    if (payload.standard !== "erc721") {
        logger.warn("Bootstrap skipped (unsupported standard)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            address: payload.address,
            standard: payload.standard,
            reason: payload.reason,
        });
        return;
    }

    logger.info("Bootstrap job received (placeholder)", {
        component: "CollectionBootstrapWorker",
        action: "handleBootstrapStart",
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        address: payload.address,
        standard: payload.standard,
        reason: payload.reason,
    });
}
