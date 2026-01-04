import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";

async function main() {
    try {
        const config = loadConfig();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });

        logger.info("Sync worker ready", {
            component: "IndexerSyncWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Sync worker shutting down", {
                component: "IndexerSyncWorker",
                action: "shutdown",
            });
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        process.stdin.resume();
    } catch (error) {
        logger.error("Sync worker startup failed", {
            component: "IndexerSyncWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();
