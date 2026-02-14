import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { startScheduler } from "../application/scheduler.js";
import { InMemoryCache } from "../infra/cache/memory.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import { ViemWebSocketHeadSource } from "../infra/rpc/viem-ws.js";
import { initRuntimeMetrics } from "../metrics/runtime.js";
import { initRuntimeApm } from "../observability/apm.js";

async function main() {
    try {
        const config = loadConfig();
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "scheduler",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.scheduler,
            worker: "scheduler",
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
            url: config.rpc.primaryUrl,
            logChunkSize: config.sync.logChunkSize,
            cache,
            metrics: runtimeMetrics.metrics,
            retryPolicy: config.rpc.retryPolicy,
            resilience: config.rpc.resilience,
        });

        const headSource = config.rpc.wsUrl
            ? new ViemWebSocketHeadSource(config.rpc.wsUrl)
            : undefined;
        const stopScheduler = await startScheduler(rpc, queue, config, {
            headSource,
            apm: runtimeApm.apm,
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
            await stopScheduler();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
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
