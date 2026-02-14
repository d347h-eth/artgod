import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { runWorker } from "../application/worker-runner.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    DEAD_LETTER_KIND,
    type DeadLetterPayload,
} from "../domain/dead-letter.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { initRuntimeMetrics } from "../metrics/runtime.js";
import { initRuntimeApm } from "../observability/apm.js";

async function main() {
    try {
        const config = loadConfig();
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            worker: "dead-letter-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.deadLetterWorker,
            worker: "dead-letter-worker",
            chainId: config.chainId,
        });
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });

        const stop = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.DeadLetter,
                consumerName: `dead-letter-${config.chainId}`,
                maxInFlight: 1,
            },
            async (job: JobEnvelope<DeadLetterPayload>) => {
                if (job.kind !== DEAD_LETTER_KIND) return;
                logger.error("Dead-letter job received", {
                    component: "IndexerDeadLetter",
                    action: "handle",
                    jobId: job.jobId,
                    failedAt: job.payload.failedAt,
                    error: job.payload.error,
                    originalJobId: job.payload.original.jobId,
                    originalKind: job.payload.original.kind,
                    originalQueue: job.payload.original.queue,
                    originalAttempt: job.payload.original.attempt,
                });
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.deadLetter.consume",
            },
        );

        logger.info("Dead-letter worker ready", {
            component: "IndexerDeadLetter",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Dead-letter worker shutting down", {
                component: "IndexerDeadLetter",
                action: "shutdown",
            });
            await stop();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        process.stdin.resume();
    } catch (error) {
        logger.error("Dead-letter worker startup failed", {
            component: "IndexerDeadLetter",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();
