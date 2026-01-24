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
import type { OnChainData } from "../domain/onchain.js";
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
import {
    ORDER_JOB_KIND,
    type OrderUpdateByIdPayload,
    type OrderUpdateByMakerPayload,
} from "../domain/order-jobs.js";

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
        const primaryRpc = new ViemRpcProvider({
            url: config.rpc.primaryUrl,
            logChunkSize: config.sync.logChunkSize,
            cache,
            metrics: noopMetrics,
        });
        const backfillRpc = config.rpc.backfillUrl
            ? new ViemRpcProvider({
                  url: config.rpc.backfillUrl,
                  logChunkSize: config.sync.logChunkSize,
                  cache,
                  metrics: noopMetrics,
              })
            : primaryRpc;
        const storage = new SqliteStorage();

        const stopRealtime = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.RealtimeSync,
                consumerName: `sync-realtime-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<RealtimeSyncPayload>) => {
                if (job.kind !== SYNC_JOB_KIND.RealtimeBlock) return;
                const range: SyncRange = {
                    fromBlock: job.payload.blockNumber,
                    toBlock: job.payload.blockNumber,
                };
                const { data, blocks } = await processRange(
                    primaryRpc,
                    storage,
                    config.chainId,
                    config.collections,
                    range,
                );
                await scheduleGapBackfill(
                    queue,
                    storage,
                    config.chainId,
                    blocks,
                );
                await publishDomainJobs(
                    queue,
                    config.chainId,
                    range,
                    job,
                    "realtime",
                    data,
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
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<BackfillSyncPayload>) => {
                if (job.kind !== SYNC_JOB_KIND.BackfillRange) return;
                const range: SyncRange = {
                    fromBlock: job.payload.fromBlock,
                    toBlock: job.payload.toBlock,
                };
                const { data, blocks } = await processRange(
                    backfillRpc,
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
                    data,
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
): Promise<{
    data: Awaited<ReturnType<typeof syncRange>>;
    blocks: RpcBlock[];
}> {
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
    data: OnChainData,
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

    await publishOrderUpdateJobs(queue, chainId, data);
}

// Gap check: if a processed block's predecessor is missing, enqueue a backfill job.
async function scheduleGapBackfill(
    queue: QueuePort,
    storage: SqliteStorage,
    chainId: number,
    blocks: RpcBlock[],
): Promise<void> {
    for (const block of blocks) {
        const previous = block.number - 1;
        if (previous <= 0) continue;
        const existing = storage.getBlockHash(chainId, previous);
        if (existing) continue;

        const job: JobEnvelope<BackfillSyncPayload> = {
            jobId: `sync:gap:${chainId}:${previous}`,
            kind: SYNC_JOB_KIND.BackfillRange,
            queue: QUEUE_NAMES.BackfillSync,
            payload: { fromBlock: previous, toBlock: previous },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
        };
        await queue.publish(QUEUE_NAMES.BackfillSync, job);
    }
}

// Order update jobs are triggered by fills/cancels/on-chain orders or maker state changes.
async function publishOrderUpdateJobs(
    queue: QueuePort,
    chainId: number,
    data: OnChainData,
): Promise<void> {
    for (const makerInfo of data.makerInfos) {
        const maker = makerInfo.maker.toLowerCase();
        const contract = makerInfo.contract?.toLowerCase() ?? "all";
        const tokenId = makerInfo.tokenId ?? "all";
        const job: JobEnvelope<OrderUpdateByMakerPayload> = {
            jobId: `orders:update:maker:${chainId}:${maker}:${contract}:${tokenId}:${makerInfo.blockNumber}:${makerInfo.logIndex}`,
            kind: ORDER_JOB_KIND.UpdateByMaker,
            queue: QUEUE_NAMES.OrdersUpdateByMaker,
            payload: {
                maker: makerInfo.maker,
                contract: makerInfo.contract,
                tokenId: makerInfo.tokenId,
                reason: makerInfo.reason,
                blockNumber: makerInfo.blockNumber,
                blockHash: makerInfo.blockHash,
                txHash: makerInfo.txHash,
                logIndex: makerInfo.logIndex,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
        };
        await queue.publish(QUEUE_NAMES.OrdersUpdateByMaker, job);
    }

    for (const fill of data.fillEvents) {
        if (!fill.orderId) continue;
        await publishOrderUpdateById(
            queue,
            chainId,
            fill.orderId,
            "fill",
            fill,
        );
    }

    for (const cancel of data.cancelEvents) {
        if (!cancel.orderId) continue;
        await publishOrderUpdateById(
            queue,
            chainId,
            cancel.orderId,
            "cancel",
            cancel,
        );
    }

    for (const order of data.orderInfos) {
        if (!order.orderId) continue;
        await publishOrderUpdateById(
            queue,
            chainId,
            order.orderId,
            "order",
            order,
        );
    }
}

async function publishOrderUpdateById(
    queue: QueuePort,
    chainId: number,
    orderId: string,
    reason: string,
    attribution: {
        blockNumber: number;
        blockHash: string;
        txHash: string;
        logIndex: number;
    },
): Promise<void> {
    const job: JobEnvelope<OrderUpdateByIdPayload> = {
        jobId: `orders:update:id:${chainId}:${orderId}:${attribution.blockNumber}:${attribution.logIndex}`,
        kind: ORDER_JOB_KIND.UpdateById,
        queue: QUEUE_NAMES.OrdersUpdateById,
        payload: {
            chainId,
            orderId,
            reason,
            blockNumber: attribution.blockNumber,
            blockHash: attribution.blockHash,
            txHash: attribution.txHash,
            logIndex: attribution.logIndex,
        },
        attempt: 0,
        scheduledAt: Date.now(),
        chainId,
    };
    await queue.publish(QUEUE_NAMES.OrdersUpdateById, job);
}
