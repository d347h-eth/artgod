import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { resolveIndexerCollectionExtension } from "../application/collection-extensions/index.js";
import type { CollectionExtensionSyncWatchSpec } from "../application/collection-extensions/types.js";
import { syncRange, type SyncRange } from "../application/sync.js";
import { runWorker } from "../application/worker-runner.js";
import { BidderIndex } from "../application/bidder-index.js";
import {
    decodeWethMakerInfos,
    WETH_EVENT_FILTERS,
} from "../application/ft/weth.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import {
    DOMAIN_JOB_KIND,
    type DomainSyncMode,
    type DomainSyncPayload,
    type MetadataRefreshPayload,
    type MetadataRefreshRangePayload,
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
import { SqliteCollectionExtensions } from "../infra/collection-extensions/sqlite.js";
import { initRuntimeMetrics } from "../metrics/runtime.js";
import {
    MAKER_TRIGGER_SCOPE,
    ORDER_JOB_KIND,
    type OrderUpdateByIdPayload,
    type OrderUpdateByMakerPayload,
} from "../domain/order-jobs.js";
import { SqliteBidderIndex } from "../infra/bidder-index/sqlite.js";
import type { Hex } from "../ports/rpc.js";
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
import type { CollectionRecord } from "../domain/collections.js";
import type { CollectionExtensionInstallPort } from "../ports/collection-extensions.js";
import type { CollectionScopeResolverPort } from "../ports/collections.js";
import { initRuntimeApm } from "../observability/apm.js";

const BIDDER_INDEX_REFRESH_MS = 30_000;

async function main() {
    try {
        const config = loadConfig();
        setDbPath(config.dbPath);
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "sync-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.syncWorker,
            worker: "sync-worker",
            chainId: config.chainId,
        });
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const cache = new InMemoryCache({
            maxEntries: config.cache.maxEntries,
            ttlMs: config.cache.ttlMs,
            metrics: runtimeMetrics.metrics,
        });
        const primaryRpc = new ViemRpcProvider({
            url: config.rpc.primaryUrl,
            logChunkSize: config.sync.logChunkSize,
            cache,
            metrics: runtimeMetrics.metrics,
            retryPolicy: config.rpc.retryPolicy,
            resilience: config.rpc.resilience,
        });
        const backfillRpc = config.rpc.backfillUrl
            ? new ViemRpcProvider({
                  url: config.rpc.backfillUrl,
                  logChunkSize: config.sync.logChunkSize,
                  cache,
                  metrics: runtimeMetrics.metrics,
                  retryPolicy: config.rpc.retryPolicy,
                  resilience: config.rpc.resilience,
              })
            : primaryRpc;
        const storage = new SqliteStorage();
        const collectionRegistry = new SqliteCollectionRegistry();
        const collectionExtensions = new SqliteCollectionExtensions();
        const bidderIndex = new BidderIndex(
            new SqliteBidderIndex(),
            config.chainId,
        );
        try {
            const initialIndex = await bidderIndex.refresh();
            logger.info("Bidder index refreshed", {
                component: "IndexerSyncWorker",
                action: "bidderIndexRefresh",
                ...initialIndex,
            });
        } catch (error) {
            logger.warn("Bidder index refresh failed", {
                component: "IndexerSyncWorker",
                action: "bidderIndexRefresh",
                error: String(error),
            });
        }
        const bidderRefreshTimer = setInterval(async () => {
            try {
                const state = await bidderIndex.refresh();
                logger.debug("Bidder index refreshed", {
                    component: "IndexerSyncWorker",
                    action: "bidderIndexRefresh",
                    ...state,
                });
            } catch (error) {
                logger.warn("Bidder index refresh failed", {
                    component: "IndexerSyncWorker",
                    action: "bidderIndexRefresh",
                    error: String(error),
                });
            }
        }, BIDDER_INDEX_REFRESH_MS);

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
                const collections = collectionRegistry.listCollectionsForSync(
                    config.chainId,
                    "realtime",
                );
                if (collections.length === 0) {
                    logger.debug("No live collections for realtime sync", {
                        component: "IndexerSyncWorker",
                        action: "syncBlock",
                        blockNumber: job.payload.blockNumber,
                    });
                    return;
                }
                const range: SyncRange = {
                    fromBlock: job.payload.blockNumber,
                    toBlock: job.payload.blockNumber,
                };
                const { data, blocks } = await processRange(
                    primaryRpc,
                    storage,
                    collectionRegistry,
                    collectionExtensions,
                    config.chainId,
                    collections,
                    range,
                    bidderIndex,
                    config.tokens.wethAddress,
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
                    collectionIds: collections.map(
                        (collection) => collection.id,
                    ),
                    blocks: blocks.length,
                    transfers: data.collectionScoped.nftTransferEvents.length,
                    balanceDeltas:
                        data.collectionScoped.nftBalanceDeltas.length,
                });
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.realtimeSync.consume",
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
                const collections = resolveBackfillCollections(
                    collectionRegistry,
                    config.chainId,
                    job.collectionId ?? null,
                );
                if (collections.length === 0) {
                    logger.debug("No collections for backfill sync", {
                        component: "IndexerSyncWorker",
                        action: "backfillRange",
                        fromBlock: job.payload.fromBlock,
                        toBlock: job.payload.toBlock,
                        collectionId: job.collectionId ?? null,
                    });
                    return;
                }
                const range: SyncRange = {
                    fromBlock: job.payload.fromBlock,
                    toBlock: job.payload.toBlock,
                };
                const { data, blocks } = await processRange(
                    backfillRpc,
                    storage,
                    collectionRegistry,
                    collectionExtensions,
                    config.chainId,
                    collections,
                    range,
                    bidderIndex,
                    config.tokens.wethAddress,
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
                    collectionIds: collections.map(
                        (collection) => collection.id,
                    ),
                    blocks: blocks.length,
                    transfers: data.collectionScoped.nftTransferEvents.length,
                    balanceDeltas:
                        data.collectionScoped.nftBalanceDeltas.length,
                });
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.backfillSync.consume",
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
            clearInterval(bidderRefreshTimer);
            await stopRealtime();
            await stopBackfill();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
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
    collectionScopeResolver: CollectionScopeResolverPort,
    collectionExtensions: CollectionExtensionInstallPort,
    chainId: number,
    collections: CollectionRecord[],
    range: SyncRange,
    bidderIndex: BidderIndex,
    wethAddress: string,
): Promise<{
    data: Awaited<ReturnType<typeof syncRange>>;
    blocks: RpcBlock[];
}> {
    const extensionWatchSpecs = resolveCollectionExtensionWatchSpecs(
        collectionExtensions,
        chainId,
        collections,
    );
    const data = await syncRange(
        rpc,
        chainId,
        collections,
        collectionScopeResolver,
        range,
        extensionWatchSpecs,
    );
    const blocks = await fetchBlocks(rpc, range);
    storage.persistSyncResult(chainId, blocks, data);
    await appendWethMakerInfos(rpc, range, wethAddress, bidderIndex, data);
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
    await publishMetadataRefreshJobs(queue, chainId, data);
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
    for (const makerTrigger of data.collectionScoped.makerTriggers) {
        const maker = makerTrigger.maker.toLowerCase();
        const job: JobEnvelope<OrderUpdateByMakerPayload> = {
            jobId: `orders:update:maker:${chainId}:${maker}:${makerTrigger.collectionId}:${makerTrigger.tokenId}:${makerTrigger.blockNumber}:${makerTrigger.logIndex}`,
            kind: ORDER_JOB_KIND.UpdateByMaker,
            queue: QUEUE_NAMES.OrdersUpdateByMaker,
            payload: {
                chainId,
                scope: MAKER_TRIGGER_SCOPE.Token,
                maker: makerTrigger.maker,
                collectionId: makerTrigger.collectionId,
                contract: makerTrigger.contract,
                tokenId: makerTrigger.tokenId,
                reason: makerTrigger.reason,
                blockNumber: makerTrigger.blockNumber,
                blockHash: makerTrigger.blockHash,
                txHash: makerTrigger.txHash,
                logIndex: makerTrigger.logIndex,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
            collectionId: makerTrigger.collectionId,
        };
        await queue.publish(QUEUE_NAMES.OrdersUpdateByMaker, job);
    }

    for (const makerTrigger of data.global.makerTriggers) {
        const maker = makerTrigger.maker.toLowerCase();
        const job: JobEnvelope<OrderUpdateByMakerPayload> = {
            jobId: `orders:update:maker:${chainId}:${maker}:global:${makerTrigger.reason}:${makerTrigger.blockNumber}:${makerTrigger.logIndex}`,
            kind: ORDER_JOB_KIND.UpdateByMaker,
            queue: QUEUE_NAMES.OrdersUpdateByMaker,
            payload: {
                chainId,
                scope: MAKER_TRIGGER_SCOPE.Global,
                maker: makerTrigger.maker,
                reason: makerTrigger.reason,
                blockNumber: makerTrigger.blockNumber,
                blockHash: makerTrigger.blockHash,
                txHash: makerTrigger.txHash,
                logIndex: makerTrigger.logIndex,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
        };
        await queue.publish(QUEUE_NAMES.OrdersUpdateByMaker, job);
    }

    for (const fill of data.collectionScoped.fillEvents) {
        if (!fill.orderId) continue;
        await publishOrderUpdateById(
            queue,
            chainId,
            fill.orderId,
            "fill",
            fill,
        );
    }

    for (const cancel of data.global.cancelEvents) {
        if (!cancel.orderId) continue;
        await publishOrderUpdateById(
            queue,
            chainId,
            cancel.orderId,
            "cancel",
            cancel,
        );
    }

    for (const order of data.collectionScoped.orderInfos) {
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

function resolveBackfillCollections(
    collectionRegistry: SqliteCollectionRegistry,
    chainId: number,
    collectionId: number | null,
): CollectionRecord[] {
    if (!collectionId) {
        return collectionRegistry.listCollectionsForSync(chainId, "backfill");
    }

    const collection = collectionRegistry.getCollection(chainId, collectionId);
    if (!collection) return [];
    if (collection.status !== "live" && collection.status !== "bootstrapping") {
        return [];
    }

    return [collection];
}

function resolveCollectionExtensionWatchSpecs(
    collectionExtensions: CollectionExtensionInstallPort,
    chainId: number,
    collections: CollectionRecord[],
): CollectionExtensionSyncWatchSpec[] {
    const specs: CollectionExtensionSyncWatchSpec[] = [];
    const seen = new Set<string>();

    for (const collection of collections) {
        const install = collectionExtensions.getInstall(chainId, collection.id);
        if (!install?.enabled) {
            continue;
        }

        const extension = resolveIndexerCollectionExtension(install);
        if (!extension) {
            continue;
        }

        for (const spec of extension.buildSyncWatchSpecs(install)) {
            const dedupeKey = `${install.collectionId}:${install.extensionKey}:${spec.sourceId}`;
            if (seen.has(dedupeKey)) {
                continue;
            }
            seen.add(dedupeKey);
            specs.push(spec);
        }
    }

    return specs;
}

// Metadata refresh jobs are triggered by on-chain refresh events (e.g. ERC-4906).
async function publishMetadataRefreshJobs(
    queue: QueuePort,
    chainId: number,
    data: OnChainData,
): Promise<void> {
    const seen = new Set<string>();
    for (const refresh of data.collectionScoped.metadataRefreshEvents) {
        const tokenId = refresh.tokenId;
        const collectionId = refresh.collectionId;
        const key = `${collectionId}:${tokenId}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const job: JobEnvelope<MetadataRefreshPayload> = {
            jobId: `metadata:refresh:${chainId}:${collectionId}:${tokenId}:${refresh.blockNumber}:${refresh.logIndex}`,
            kind: DOMAIN_JOB_KIND.MetadataRefresh,
            queue: QUEUE_NAMES.MetadataRefresh,
            payload: {
                chainId,
                collectionId,
                tokenId,
                metadataUrl: null,
                reason: refresh.trigger,
                source: "onchain",
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
            collectionId,
        };
        await queue.publish(QUEUE_NAMES.MetadataRefresh, job);
    }

    const seenRanges = new Set<string>();
    for (const refresh of data.collectionScoped.metadataRefreshRangeEvents) {
        const key = `${refresh.collectionId}:${refresh.fromTokenId}:${refresh.toTokenId}`;
        if (seenRanges.has(key)) {
            continue;
        }
        seenRanges.add(key);

        const rangeJob: JobEnvelope<MetadataRefreshRangePayload> = {
            jobId: `metadata:refresh-range:${chainId}:${refresh.collectionId}:${refresh.fromTokenId}:${refresh.toTokenId}:${refresh.blockNumber}:${refresh.logIndex}`,
            kind: DOMAIN_JOB_KIND.MetadataRefreshRange,
            queue: QUEUE_NAMES.MetadataRefresh,
            payload: {
                chainId,
                collectionId: refresh.collectionId,
                fromTokenId: refresh.fromTokenId,
                toTokenId: refresh.toTokenId,
                cursorTokenId: refresh.fromTokenId,
                reason: refresh.trigger,
                source: "onchain",
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
            collectionId: refresh.collectionId,
        };
        await queue.publish(QUEUE_NAMES.MetadataRefresh, rangeJob);
    }
}

async function appendWethMakerInfos(
    rpc: RpcProviderPort,
    range: SyncRange,
    wethAddress: string,
    bidderIndex: BidderIndex,
    data: OnChainData,
): Promise<void> {
    if (!bidderIndex.isActive()) return;
    if (range.fromBlock > range.toBlock) return;

    const logs = await rpc.getLogs({
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        address: wethAddress as Hex,
        events: WETH_EVENT_FILTERS,
    });
    const makers = decodeWethMakerInfos(logs, bidderIndex);
    data.global.makerTriggers.push(...makers);
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
