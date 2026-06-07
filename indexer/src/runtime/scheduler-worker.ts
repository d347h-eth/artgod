import { logger } from "@artgod/shared/utils";
import { setDbPath } from "@artgod/shared/database";
import { loadConfig } from "../config/index.js";
import { startSchedulerWorker } from "../application/scheduler-worker.js";
import { InMemoryCache } from "../infra/cache/memory.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import { ViemWebSocketHeadSource } from "../infra/rpc/viem-ws.js";
import {
    INDEXER_RPC_ENDPOINT_ID_PREFIX,
    INDEXER_RPC_OBSERVABILITY_COMPONENT,
} from "../infra/rpc/observability.js";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import { initRuntimeApm } from "@artgod/shared/observability/apm";

async function main() {
    try {
        const config = loadConfig();
        setDbPath(config.dbPath);
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "scheduler-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.schedulerWorker,
            worker: "scheduler-worker",
            chainId: config.chainId,
        });
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const cache = new InMemoryCache({
            maxEntries: config.cache.maxEntries,
            ttlMs: config.cache.ttlMs,
            metrics: runtimeMetrics.metrics,
        });
        const rpc = new ViemRpcProvider({
            endpoints: config.rpc.endpoints,
            logChunkSize: config.sync.logChunkSize,
            cache,
            metrics: runtimeMetrics.metrics,
            component: INDEXER_RPC_OBSERVABILITY_COMPONENT.SchedulerHttp,
            endpointIdPrefix: INDEXER_RPC_ENDPOINT_ID_PREFIX.SchedulerHttp,
            retryPolicy: config.rpc.retryPolicy,
            resilience: config.rpc.resilience,
        });

        const headSource = config.rpc.wsEndpoints
            ? new ViemWebSocketHeadSource(config.rpc.wsEndpoints, {
                  metrics: runtimeMetrics.metrics,
                  component:
                      INDEXER_RPC_OBSERVABILITY_COMPONENT.SchedulerWebSocket,
                  endpointIdPrefix:
                      INDEXER_RPC_ENDPOINT_ID_PREFIX.SchedulerWebSocket,
              })
            : undefined;
        const stopSchedulerWorker = await startSchedulerWorker(
            rpc,
            queue,
            config,
            {
                headSource,
                apm: runtimeApm.apm,
            },
        );

        logger.info("Scheduler-worker ready", {
            component: "IndexerSchedulerWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Scheduler-worker shutting down", {
                component: "IndexerSchedulerWorker",
                action: "shutdown",
            });
            await stopSchedulerWorker();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    } catch (error) {
        logger.error("Scheduler-worker startup failed", {
            component: "IndexerSchedulerWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();
