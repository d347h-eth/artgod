import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { syncRange } from "../application/sync.js";
import { runWorker } from "../application/worker-runner.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { SYNC_JOB_KIND } from "../domain/sync-jobs.js";
import type {
    BackfillSyncPayload,
    RealtimeSyncPayload,
} from "../domain/sync-jobs.js";
import { InMemoryCache } from "../infra/cache/memory.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import { noopMetrics } from "../metrics/noop.js";

async function main() {
    try {
        const config = loadConfig();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const cache = new InMemoryCache({
            maxEntries: config.cache.maxEntries,
            ttlMs: config.cache.ttlMs,
            metrics: noopMetrics,
        });
        const rpc = new ViemRpcProvider({
            url: config.rpc.primaryUrl,
            logChunkSize: config.sync.logChunkSize,
            cache,
            metrics: noopMetrics,
        });

        const stopRealtime = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.RealtimeSync,
                consumerName: `sync-realtime-${config.chainId}`,
                maxInFlight: 1,
            },
            async (job: JobEnvelope<RealtimeSyncPayload>) => {
                if (job.kind !== SYNC_JOB_KIND.RealtimeBlock) return;
                const range = { fromBlock: job.payload.blockNumber, toBlock: job.payload.blockNumber };
                const data = await syncRange(rpc, config.collections, range);
                logger.info("Sync block processed", {
                    component: "IndexerSyncWorker",
                    action: "syncBlock",
                    blockNumber: job.payload.blockNumber,
                    transfers: data.nftTransferEvents.length,
                    balanceDeltas: data.nftBalanceDeltas.length,
                });
            },
        );

        const stopBackfill = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.BackfillSync,
                consumerName: `sync-backfill-${config.chainId}`,
                maxInFlight: 1,
            },
            async (job: JobEnvelope<BackfillSyncPayload>) => {
                if (job.kind !== SYNC_JOB_KIND.BackfillRange) return;
                const range = { fromBlock: job.payload.fromBlock, toBlock: job.payload.toBlock };
                const data = await syncRange(rpc, config.collections, range);
                logger.info("Backfill range processed", {
                    component: "IndexerSyncWorker",
                    action: "backfillRange",
                    fromBlock: job.payload.fromBlock,
                    toBlock: job.payload.toBlock,
                    transfers: data.nftTransferEvents.length,
                    balanceDeltas: data.nftBalanceDeltas.length,
                });
            },
        );

        logger.info("Sync worker ready", {
            component: "IndexerSyncWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Sync worker shutting down", {
                component: "IndexerSyncWorker",
                action: "shutdown",
            });
            await stopRealtime();
            await stopBackfill();
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
