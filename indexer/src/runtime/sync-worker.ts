import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { loadConfig, type CollectionConfig } from "../config/index.js";
import { syncRange, type SyncRange } from "../application/sync.js";
import { runWorker } from "../application/worker-runner.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import {
    DOMAIN_JOB_KIND,
    type DomainSyncMode,
    type DomainSyncPayload,
} from "../domain/domain-jobs.js";
import { SYNC_JOB_KIND } from "../domain/sync-jobs.js";
import type {
    BackfillSyncPayload,
    RealtimeSyncPayload,
} from "../domain/sync-jobs.js";
import type { RpcBlock, RpcProviderPort } from "../ports/rpc.js";
import type { QueuePort } from "../ports/queue.js";
import { InMemoryCache } from "../infra/cache/memory.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import { SqliteStorage } from "../infra/storage/sqlite.js";
import { noopMetrics } from "../metrics/noop.js";

async function main() {
    try {
        const config = loadConfig();
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
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
        const storage = new SqliteStorage();

        const stopRealtime = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.RealtimeSync,
                consumerName: `sync-realtime-${config.chainId}`,
                maxInFlight: 1,
            },
            async (job: JobEnvelope<RealtimeSyncPayload>) => {
                if (job.kind !== SYNC_JOB_KIND.RealtimeBlock) return;
                const range: SyncRange = {
                    fromBlock: job.payload.blockNumber,
                    toBlock: job.payload.blockNumber,
                };
                const { data, blocks } = await processRange(
                    rpc,
                    storage,
                    config.chainId,
                    config.collections,
                    range,
                );
                await publishDomainJobs(
                    queue,
                    config.chainId,
                    range,
                    job,
                    "realtime",
                );
                logger.info("Sync block processed", {
                    component: "IndexerSyncWorker",
                    action: "syncBlock",
                    blockNumber: job.payload.blockNumber,
                    blocks: blocks.length,
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
                const range: SyncRange = {
                    fromBlock: job.payload.fromBlock,
                    toBlock: job.payload.toBlock,
                };
                const { data, blocks } = await processRange(
                    rpc,
                    storage,
                    config.chainId,
                    config.collections,
                    range,
                );
                await publishDomainJobs(
                    queue,
                    config.chainId,
                    range,
                    job,
                    "backfill",
                );
                logger.info("Backfill range processed", {
                    component: "IndexerSyncWorker",
                    action: "backfillRange",
                    fromBlock: job.payload.fromBlock,
                    toBlock: job.payload.toBlock,
                    blocks: blocks.length,
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

async function processRange(
    rpc: RpcProviderPort,
    storage: SqliteStorage,
    chainId: number,
    collections: CollectionConfig[],
    range: SyncRange,
): Promise<{ data: Awaited<ReturnType<typeof syncRange>>; blocks: RpcBlock[] }> {
    const data = await syncRange(rpc, collections, range);
    const blocks = await fetchBlocks(rpc, range);
    storage.persistSyncResult(chainId, blocks, data);
    return { data, blocks };
}

async function fetchBlocks(
    rpc: RpcProviderPort,
    range: SyncRange,
): Promise<RpcBlock[]> {
    if (range.fromBlock > range.toBlock) return [];
    const blocks: RpcBlock[] = [];
    for (let block = range.fromBlock; block <= range.toBlock; block += 1) {
        blocks.push(await rpc.getBlock(block));
    }
    return blocks;
}

async function publishDomainJobs<TPayload>(
    queue: QueuePort,
    chainId: number,
    range: SyncRange,
    job: JobEnvelope<TPayload>,
    mode: DomainSyncMode,
): Promise<void> {
    const payload: DomainSyncPayload = {
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        mode,
        sourceJobId: job.jobId,
        sourceKind: job.kind,
    };

    const ordersJob: JobEnvelope<DomainSyncPayload> = {
        jobId: `domain:orders:${job.jobId}`,
        kind: DOMAIN_JOB_KIND.OrdersSync,
        queue: QUEUE_NAMES.OrdersDomain,
        payload,
        attempt: 0,
        scheduledAt: Date.now(),
        chainId,
    };
    const metadataJob: JobEnvelope<DomainSyncPayload> = {
        jobId: `domain:metadata:${job.jobId}`,
        kind: DOMAIN_JOB_KIND.MetadataSync,
        queue: QUEUE_NAMES.MetadataDomain,
        payload,
        attempt: 0,
        scheduledAt: Date.now(),
        chainId,
    };
    const activityJob: JobEnvelope<DomainSyncPayload> = {
        jobId: `domain:activity:${job.jobId}`,
        kind: DOMAIN_JOB_KIND.ActivitySync,
        queue: QUEUE_NAMES.ActivityDomain,
        payload,
        attempt: 0,
        scheduledAt: Date.now(),
        chainId,
    };

    await queue.publish(QUEUE_NAMES.OrdersDomain, ordersJob);
    await queue.publish(QUEUE_NAMES.MetadataDomain, metadataJob);
    await queue.publish(QUEUE_NAMES.ActivityDomain, activityJob);
}
