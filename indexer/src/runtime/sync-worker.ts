import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import {
    BackfillExecutionGate,
    resolveBackfillExecutionMode,
} from "../application/backfill-execution.js";
import { resolveIndexerCollectionExtension } from "../application/collection-extensions/index.js";
import type { CollectionExtensionSyncWatchSpec } from "../application/collection-extensions/types.js";
import { syncRange, type SyncRange } from "../application/sync.js";
import { runWorker } from "../application/worker-runner.js";
import { BidderIndex } from "../application/bidder-index.js";
import {
    decodeWethMakerInfos,
    WETH_EVENT_FILTERS,
} from "../application/ft/weth.js";
import { shouldFetchWethMakerLogs } from "../application/backfill-order-maintenance.js";
import {
    canAnyCollectionProjectCurrentStateAt,
    publishOrderUpdateJobs,
} from "../application/order-update-fanout.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import {
    DOMAIN_JOB_KIND,
    DOMAIN_SYNC_PROJECTION,
    type DomainSyncMode,
    type DomainSyncPayload,
    type MetadataRefreshPayload,
    type MetadataRefreshRangePayload,
} from "../domain/domain-jobs.js";
import type { OnChainData } from "../domain/onchain.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
    SYNC_JOB_KIND,
} from "../domain/sync-jobs.js";
import type {
    BackfillOrderMaintenancePolicy,
    BackfillSyncPayload,
    RealtimeSyncPayload,
} from "../domain/sync-jobs.js";
import type { RpcBlock, RpcProviderPort } from "../ports/rpc.js";
import type { QueuePort } from "../ports/queue.js";
import { InMemoryCache } from "../infra/cache/memory.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import {
    INDEXER_RPC_ENDPOINT_ID_PREFIX,
    INDEXER_RPC_OBSERVABILITY_COMPONENT,
} from "../infra/rpc/observability.js";
import { SqliteStorage } from "../infra/storage/sqlite.js";
import { SqliteCollectionExtensions } from "../infra/collection-extensions/sqlite.js";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import { SqliteBidderIndex } from "../infra/bidder-index/sqlite.js";
import type { Hex } from "../ports/rpc.js";
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
import type { CollectionRecord } from "../domain/collections.js";
import type { CollectionExtensionInstallPort } from "../ports/collection-extensions.js";
import type { CollectionScopeResolverPort } from "../ports/collections.js";
import { initRuntimeApm } from "@artgod/shared/observability/apm";

const BIDDER_INDEX_REFRESH_MS = 30_000;
const BACKFILL_LEASE_EXTENSION_MS = 10_000;

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
            endpoints: config.rpc.endpoints,
            logChunkSize: config.sync.logChunkSize,
            cache,
            metrics: runtimeMetrics.metrics,
            component: INDEXER_RPC_OBSERVABILITY_COMPONENT.PrimaryHttp,
            endpointIdPrefix: INDEXER_RPC_ENDPOINT_ID_PREFIX.PrimaryHttp,
            retryPolicy: config.rpc.retryPolicy,
            resilience: config.rpc.resilience,
        });
        const backfillRpc = config.rpc.backfillEndpoints
            ? new ViemRpcProvider({
                  endpoints: config.rpc.backfillEndpoints,
                  logChunkSize: config.sync.logChunkSize,
                  cache,
                  metrics: runtimeMetrics.metrics,
                  component: INDEXER_RPC_OBSERVABILITY_COMPONENT.BackfillHttp,
                  endpointIdPrefix: INDEXER_RPC_ENDPOINT_ID_PREFIX.BackfillHttp,
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
        const backfillExecutionGate = new BackfillExecutionGate();

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
                    logger.debug("No realtime collections for sync", {
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
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
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
                    collections,
                    range,
                    job,
                    "realtime",
                    data,
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
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
                    nftApprovals:
                        data.collectionScoped.nftApprovalEvents.length,
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
                maxInFlight: config.sync.backfillWorkerCount,
                extendLeaseMs: BACKFILL_LEASE_EXTENSION_MS,
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
                const orderMaintenancePolicy =
                    job.payload.orderMaintenancePolicy;
                const executionMode = resolveBackfillExecutionMode(
                    collections,
                    range,
                );
                await backfillExecutionGate.run(executionMode, async () => {
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
                        orderMaintenancePolicy,
                    );
                    await publishDomainJobs(
                        queue,
                        config.chainId,
                        collections,
                        range,
                        job,
                        "backfill",
                        data,
                        orderMaintenancePolicy,
                    );
                    logger.info("Backfill range processed", {
                        component: "IndexerSyncWorker",
                        action: "backfillRange",
                        fromBlock: job.payload.fromBlock,
                        toBlock: job.payload.toBlock,
                        source: job.payload.source,
                        orderMaintenancePolicy,
                        collectionIds: collections.map(
                            (collection) => collection.id,
                        ),
                        backfillExecutionMode: executionMode,
                        backfillWorkerCount: config.sync.backfillWorkerCount,
                        blocks: blocks.length,
                        transfers:
                            data.collectionScoped.nftTransferEvents.length,
                        nftApprovals:
                            data.collectionScoped.nftApprovalEvents.length,
                        balanceDeltas:
                            data.collectionScoped.nftBalanceDeltas.length,
                    });
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
            backfillWorkerCount: config.sync.backfillWorkerCount,
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
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy,
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
    storage.persistSyncResult(chainId, blocks, data, collections);
    await appendWethMakerInfos(
        rpc,
        range,
        wethAddress,
        bidderIndex,
        data,
        collections,
        orderMaintenancePolicy,
    );
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
    collections: CollectionRecord[],
    range: SyncRange,
    job: JobEnvelope<TPayload>,
    mode: DomainSyncMode,
    data: OnChainData,
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy,
): Promise<void> {
    // Build the current-state sync payload for this range.
    const currentStatePayload: DomainSyncPayload = {
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        mode,
        projection: DOMAIN_SYNC_PROJECTION.CurrentState,
        sourceJobId: job.jobId,
        sourceKind: job.kind,
    };
    // Build the facts-only sync payload for this range.
    const factsOnlyPayload: DomainSyncPayload = {
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        mode,
        projection: DOMAIN_SYNC_PROJECTION.FactsOnly,
        sourceJobId: job.jobId,
        sourceKind: job.kind,
    };

    const activityJob: JobEnvelope<DomainSyncPayload> = {
        jobId: `domain:activity:${job.jobId}`,
        kind: DOMAIN_JOB_KIND.ActivitySync,
        queue: QUEUE_NAMES.ActivityDomain,
        payload: factsOnlyPayload,
        attempt: 0,
        scheduledAt: Date.now(),
        chainId,
        collectionId: job.collectionId,
    };

    await queue.publish(QUEUE_NAMES.ActivityDomain, activityJob);

    // Skip current-state fanout for fully pre-anchor ranges.
    if (!hasAnyCurrentStateProjection(collections, range)) {
        return;
    }

    const ordersJob: JobEnvelope<DomainSyncPayload> = {
        jobId: `domain:orders:${job.jobId}`,
        kind: DOMAIN_JOB_KIND.OrdersSync,
        queue: QUEUE_NAMES.OrdersDomain,
        payload: currentStatePayload,
        attempt: 0,
        scheduledAt: Date.now(),
        chainId,
        collectionId: job.collectionId,
    };
    const metadataJob: JobEnvelope<DomainSyncPayload> = {
        jobId: `domain:metadata:${job.jobId}`,
        kind: DOMAIN_JOB_KIND.MetadataSync,
        queue: QUEUE_NAMES.MetadataDomain,
        payload: currentStatePayload,
        attempt: 0,
        scheduledAt: Date.now(),
        chainId,
        collectionId: job.collectionId,
    };
    const currentStateData = filterCurrentStateOnChainData(collections, data);

    await queue.publish(QUEUE_NAMES.OrdersDomain, ordersJob);
    await queue.publish(QUEUE_NAMES.MetadataDomain, metadataJob);

    // Only post-anchor events may drive current-state side effects.
    await publishOrderUpdateJobs(
        queue,
        chainId,
        collections,
        currentStateData,
        orderMaintenancePolicy,
    );
    await publishMetadataRefreshJobs(
        queue,
        chainId,
        collections,
        currentStateData,
    );
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
            payload: {
                fromBlock: previous,
                toBlock: previous,
                source: BACKFILL_SOURCE.GapRepair,
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
            },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
        };
        await queue.publish(QUEUE_NAMES.BackfillSync, job);
    }
}

function resolveBackfillCollections(
    collectionRegistry: SqliteCollectionRegistry,
    chainId: number,
    collectionId: number | null,
): CollectionRecord[] {
    // Collection-scoped jobs stay pinned to one collection.
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
    // De-duplicate extension watches by install and source.
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
    collections: CollectionRecord[],
    data: OnChainData,
): Promise<void> {
    const seen = new Set<string>();
    for (const refresh of data.collectionScoped.metadataRefreshEvents) {
        const collection = collections.find(
            (candidate) => candidate.id === refresh.collectionId,
        );
        if (!collection?.canProjectCurrentStateAt(refresh.blockNumber)) {
            continue;
        }
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
        const collection = collections.find(
            (candidate) => candidate.id === refresh.collectionId,
        );
        if (!collection?.canProjectCurrentStateAt(refresh.blockNumber)) {
            continue;
        }
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
    collections: CollectionRecord[],
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy,
): Promise<void> {
    // WETH triggers only matter for current-state maker revalidation.
    if (
        !shouldFetchWethMakerLogs({
            orderMaintenancePolicy,
            range,
            bidderIndexActive: bidderIndex.isActive(),
            hasCurrentStateProjection: hasAnyCurrentStateProjection(
                collections,
                range,
            ),
        })
    ) {
        return;
    }

    const logs = await rpc.getLogs({
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        address: wethAddress as Hex,
        events: WETH_EVENT_FILTERS,
    });
    const makers = decodeWethMakerInfos(logs, bidderIndex);
    data.global.makerTriggers.push(...makers);
}

function hasAnyCurrentStateProjection(
    collections: CollectionRecord[],
    range: SyncRange,
): boolean {
    // Coarse gate for current-state fanout.
    return collections.some(
        (collection) =>
            collection.intersectCurrentStateWindow(
                range.fromBlock,
                range.toBlock,
            ) !== null,
    );
}

function filterCurrentStateOnChainData(
    collections: CollectionRecord[],
    data: OnChainData,
): OnChainData {
    // Drop pre-anchor collection-scoped events.
    const collectionsById = new Map(
        collections.map((collection) => [collection.id, collection]),
    );

    return {
        transactions: data.transactions,
        collectionScoped: {
            nftTransferEvents: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.nftTransferEvents,
            ),
            nftApprovalEvents: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.nftApprovalEvents,
            ),
            nftBalanceDeltas: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.nftBalanceDeltas,
            ),
            fillEvents: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.fillEvents,
            ),
            orderInfos: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.orderInfos,
            ),
            makerTriggers: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.makerTriggers,
            ),
            metadataRefreshEvents: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.metadataRefreshEvents,
            ),
            metadataRefreshRangeEvents:
                filterCurrentStateCollectionScopedEvents(
                    collectionsById,
                    data.collectionScoped.metadataRefreshRangeEvents,
                ),
            collectionExtensionEvents: filterCurrentStateCollectionScopedEvents(
                collectionsById,
                data.collectionScoped.collectionExtensionEvents,
            ),
            collectionExtensionEventMedia:
                filterCurrentStateCollectionScopedEvents(
                    collectionsById,
                    data.collectionScoped.collectionExtensionEventMedia,
                ),
        },
        global: {
            cancelEvents: data.global.cancelEvents.filter((event) =>
                canAnyCollectionProjectCurrentStateAt(
                    collections,
                    event.blockNumber,
                ),
            ),
            makerTriggers: data.global.makerTriggers.filter((event) =>
                canAnyCollectionProjectCurrentStateAt(
                    collections,
                    event.blockNumber,
                ),
            ),
        },
    };
}

function filterCurrentStateCollectionScopedEvents<
    TEvent extends { collectionId: number; blockNumber: number },
>(collectionsById: Map<number, CollectionRecord>, events: TEvent[]): TEvent[] {
    // Keep only post-anchor collection-scoped events.
    return events.filter((event) =>
        collectionsById
            .get(event.collectionId)
            ?.canProjectCurrentStateAt(event.blockNumber),
    );
}
