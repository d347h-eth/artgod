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

        logger.info("Scheduler ready", {
            component: "IndexerScheduler",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Scheduler shutting down", {
                component: "IndexerScheduler",
                action: "shutdown",
            });
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        process.stdin.resume();
    } catch (error) {
        logger.error("Scheduler startup failed", {
            component: "IndexerScheduler",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();
