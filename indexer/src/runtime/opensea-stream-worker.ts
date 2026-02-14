import { logger } from "@artgod/shared/utils";
import { loadOffchainConfig } from "../config/offchain.js";
import {
    OFFCHAIN_JOB_KIND,
    type OffchainOrderRawPayload,
} from "../domain/offchain-jobs.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { OpenSeaFixtureSource } from "../infra/offchain/opensea-fixtures.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { initRuntimeMetrics } from "../metrics/runtime.js";
import { initRuntimeApm } from "../observability/apm.js";

async function main() {
    try {
        const config = loadOffchainConfig();
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "opensea-stream-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.port,
            worker: "opensea-stream-worker",
            chainId: config.chainId,
        });
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });

        const source = new OpenSeaFixtureSource({
            fixturesDir: config.opensea.fixturesDir,
            chainId: config.chainId,
            source: config.opensea.source,
            delayMs: config.opensea.delayMs,
        });
        // Fixture payloads are published as raw OpenSea events.
        // Normalization into orders happens in the offchain ingest worker.

        const shutdown = async () => {
            logger.info("OpenSea stream worker shutting down", {
                component: "OpenSeaStreamWorker",
                action: "shutdown",
            });
            await source.stop();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        process.stdin.resume();

        await source.start(async (event) => {
            const publishJob = async (): Promise<void> => {
                const jobId = event.eventId
                    ? `offchain:raw:${event.source}:${event.chainId}:${event.eventId}`
                    : `offchain:raw:${event.source}:${event.chainId}:${event.receivedAt}`;

                const job: JobEnvelope<OffchainOrderRawPayload> = {
                    jobId,
                    kind: OFFCHAIN_JOB_KIND.OrderRaw,
                    queue: QUEUE_NAMES.OffchainOrdersRaw,
                    payload: {
                        source: event.source,
                        chainId: event.chainId,
                        receivedAt: event.receivedAt,
                        payload: event.payload,
                    },
                    attempt: 0,
                    scheduledAt: Date.now(),
                    traceId: event.eventId,
                    chainId: event.chainId,
                };

                await queue.publish(QUEUE_NAMES.OffchainOrdersRaw, job);

                logger.debug("OpenSea event published", {
                    component: "OpenSeaStreamWorker",
                    action: "publish",
                    source: event.source,
                    chainId: event.chainId,
                    eventId: event.eventId,
                    jobId,
                });
            };

            await runtimeApm.apm.withSpan(
                "worker.openseaStream.publish",
                {
                    source: event.source,
                    chainId: event.chainId,
                    eventId: event.eventId ?? null,
                },
                publishJob,
            );
        });

        logger.info("OpenSea fixture replay complete", {
            component: "OpenSeaStreamWorker",
            action: "replayComplete",
            source: config.opensea.source,
        });
    } catch (error) {
        logger.error("OpenSea stream worker failed", {
            component: "OpenSeaStreamWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();
