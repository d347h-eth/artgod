import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import {
    BackfillExecutionGate,
    resolveBackfillExecutionMode,
} from "../application/backfill-execution.js";
import type { SyncRange } from "../application/sync.js";
import {
    processRange,
    publishDomainJobs,
    resolveBackfillCollections,
} from "../application/sync-range-processing.js";
import { executeSyncGapRepair } from "../application/sync-gap-scheduler.js";
import { executeReorgResync } from "../application/reorg-recovery.js";
import { SqliteReorgRecoveries } from "../infra/storage/sqlite-reorg-recoveries.js";
import { SqliteQueueOutbox } from "../infra/queue/sqlite-queue-outbox.js";
import { runWorker } from "../application/worker-runner.js";
import { BidderIndex } from "../application/bidder-index.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
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
import { InMemoryCache } from "../infra/cache/memory.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import {
    INDEXER_RPC_ENDPOINT_ID_PREFIX,
    INDEXER_RPC_OBSERVABILITY_COMPONENT,
} from "../infra/rpc/observability.js";
import { SqliteStorage } from "../infra/storage/sqlite.js";
import { SqliteSyncGapStore } from "../infra/storage/sqlite-sync-gaps.js";
import { SqliteCollectionExtensions } from "../infra/collection-extensions/sqlite.js";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import { SqliteBidderIndex } from "../infra/bidder-index/sqlite.js";
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
import type { CollectionRecord } from "../domain/collections.js";
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
        const syncGapStore = new SqliteSyncGapStore();
        const reorgRecoveries = new SqliteReorgRecoveries(
            storage,
            new SqliteQueueOutbox(),
        );
        const collectionRegistry = new SqliteCollectionRegistry();
        const collectionExtensions = new SqliteCollectionExtensions(
            config.debugPayloads,
        );
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
                const { data, blocks } = await processRange({
                    rpc: primaryRpc,
                    storage,
                    collectionScopeResolver: collectionRegistry,
                    collectionExtensions,
                    chainId: config.chainId,
                    collections,
                    range,
                    bidderIndex,
                    wethAddress: config.tokens.wethAddress,
                    orderMaintenancePolicy:
                        BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
                });
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
                const isGapRepair =
                    job.payload.source === BACKFILL_SOURCE.GapRepair;
                const isReorgRecovery =
                    job.payload.source === BACKFILL_SOURCE.ReorgRecovery;
                if (isReorgRecovery && job.chainId !== config.chainId) return;
                // Legacy predecessor hints were unscoped. The scheduler now
                // rediscovers their missing coverage through durable scoped work.
                if (
                    isGapRepair &&
                    (job.collectionId === undefined ||
                        job.chainId !== config.chainId)
                )
                    return;
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
                    const syncAndPublish = async (
                        collections: CollectionRecord[],
                    ) => {
                        const { data, blocks } = await processRange({
                            rpc: backfillRpc,
                            storage,
                            collectionScopeResolver: collectionRegistry,
                            collectionExtensions,
                            chainId: config.chainId,
                            collections,
                            range,
                            bidderIndex,
                            wethAddress: config.tokens.wethAddress,
                            orderMaintenancePolicy: orderMaintenancePolicy,
                        });
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
                            backfillWorkerCount:
                                config.sync.backfillWorkerCount,
                            blocks: blocks.length,
                            transfers:
                                data.collectionScoped.nftTransferEvents.length,
                            nftApprovals:
                                data.collectionScoped.nftApprovalEvents.length,
                            balanceDeltas:
                                data.collectionScoped.nftBalanceDeltas.length,
                        });
                    };
                    if (isGapRepair) {
                        await executeSyncGapRepair(
                            job,
                            collectionRegistry,
                            syncGapStore,
                            (collection) => syncAndPublish([collection]),
                        );
                    } else if (isReorgRecovery) {
                        // Reload after gate admission. An empty eligible set does
                        // not complete recovery; its durable range remains pending.
                        const currentCollections = resolveBackfillCollections(
                            collectionRegistry,
                            config.chainId,
                            job.collectionId ?? null,
                        );
                        if (!currentCollections.length) return;
                        await executeReorgResync(
                            job,
                            reorgRecoveries,
                            { batchSize: config.sync.backfillBatchSize },
                            () => syncAndPublish(currentCollections),
                        );
                    } else {
                        await syncAndPublish(collections);
                    }
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
