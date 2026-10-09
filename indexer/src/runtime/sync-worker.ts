import { connectIndexerRpcBudget } from "./rpc-budget.js";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { BackfillExecutionGate } from "../application/backfill-execution.js";
import type { SyncRange } from "../application/sync.js";
import {
    domainSyncSource,
    processSyncRange,
} from "../application/sync-range-processing.js";
import {
    createBackfillSyncHandler,
    SYNC_WORKER_LOG_COMPONENT,
} from "../application/backfill-sync-handler.js";
import {
    AutomaticSyncExecutor,
    startAutomaticSyncLoop,
} from "../application/automatic-sync-executor.js";
import { SyncGapScheduler } from "../application/sync-gap-scheduler.js";
import { SYNC_WORK_COMPLETION } from "../domain/sync-work.js";
import { SqliteSyncRangeCommit } from "../infra/storage/sqlite-sync-range-commit.js";
import { SqliteReorgRecoveries } from "../infra/storage/sqlite-reorg-recoveries.js";
import { SqliteQueueOutbox } from "../infra/queue/sqlite-queue-outbox.js";
import { runWorker } from "../application/worker-runner.js";
import { BidderIndex } from "../application/bidder-index.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    SYNC_JOB_KIND,
} from "../domain/sync-jobs.js";
import type { RealtimeSyncPayload } from "../domain/sync-jobs.js";
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
        const rpcAllocation = await connectIndexerRpcBudget(config, {
            owner: false,
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
            requestBudget: rpcAllocation.requestBudget,
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
                  requestBudget: rpcAllocation.requestBudget,
              })
            : primaryRpc;
        const storage = new SqliteStorage();
        const syncGapStore = new SqliteSyncGapStore();
        const reorgRecoveries = new SqliteReorgRecoveries(storage);
        const outbox = new SqliteQueueOutbox();
        const collectionRegistry = new SqliteCollectionRegistry();
        const commit = new SqliteSyncRangeCommit({
            storage,
            outbox,
            gaps: syncGapStore,
            recoveries: reorgRecoveries,
            collections: collectionRegistry,
        });
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
                component: SYNC_WORKER_LOG_COMPONENT,
                action: "bidderIndexRefresh",
                ...initialIndex,
            });
        } catch (error) {
            logger.warn("Bidder index refresh failed", {
                component: SYNC_WORKER_LOG_COMPONENT,
                action: "bidderIndexRefresh",
                error: String(error),
            });
        }
        const bidderRefreshTimer = setInterval(async () => {
            try {
                const state = await bidderIndex.refresh();
                logger.debug("Bidder index refreshed", {
                    component: SYNC_WORKER_LOG_COMPONENT,
                    action: "bidderIndexRefresh",
                    ...state,
                });
            } catch (error) {
                logger.warn("Bidder index refresh failed", {
                    component: SYNC_WORKER_LOG_COMPONENT,
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
                        component: SYNC_WORKER_LOG_COMPONENT,
                        action: "syncBlock",
                        blockNumber: job.payload.blockNumber,
                    });
                    return;
                }
                const range: SyncRange = {
                    fromBlock: job.payload.blockNumber,
                    toBlock: job.payload.blockNumber,
                };
                const { data, blocks } = await processSyncRange({
                    rpc: primaryRpc,
                    storage,
                    commit,
                    sources: [domainSyncSource(job)],
                    mode: "realtime",
                    completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
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
                logger.info("Sync block processed", {
                    component: SYNC_WORKER_LOG_COMPONENT,
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
                workScope: rpcAllocation.workScope,
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
            createBackfillSyncHandler({
                chainId: config.chainId,
                workerCount: config.sync.backfillWorkerCount,
                wethAddress: config.tokens.wethAddress,
                rpc: backfillRpc,
                storage,
                commit,
                collectionsPort: collectionRegistry,
                extensions: collectionExtensions,
                bidderIndex,
                gate: backfillExecutionGate,
            }),
            {
                workScope: rpcAllocation.workScope,
                apm: runtimeApm.apm,
                spanName: "worker.backfillSync.consume",
            },
        );

        const stopAutomaticSync = startAutomaticSyncLoop(
            new AutomaticSyncExecutor({
                chainId: config.chainId,
                rpc: backfillRpc,
                storage,
                commit,
                collectionsPort: collectionRegistry,
                collectionExtensions,
                bidderIndex,
                wethAddress: config.tokens.wethAddress,
                gaps: syncGapStore,
                gapWorkEnabled: config.rpc.gapAllocation.requestsPerSecond > 0,
                workScope: rpcAllocation.workScope,
                gapScheduler: new SyncGapScheduler(
                    collectionRegistry,
                    syncGapStore,
                    {
                        chainId: config.chainId,
                        batchSize: config.sync.backfillBatchSize,
                    },
                ),
                recoveries: reorgRecoveries,
                gate: backfillExecutionGate,
                batchSize: config.sync.backfillBatchSize,
            }),
        );

        logger.info("Sync worker ready", {
            component: SYNC_WORKER_LOG_COMPONENT,
            action: "main",
            backfillWorkerCount: config.sync.backfillWorkerCount,
        });

        const shutdown = async () => {
            rpcAllocation.budget.stopWaiting();
            logger.info("Sync worker shutting down", {
                component: SYNC_WORKER_LOG_COMPONENT,
                action: "shutdown",
            });
            clearInterval(bidderRefreshTimer);
            await Promise.all([
                stopAutomaticSync(),
                stopRealtime(),
                stopBackfill(),
            ]);
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await rpcAllocation.budget.close();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    } catch (error) {
        logger.error("Sync worker startup failed", {
            component: SYNC_WORKER_LOG_COMPONENT,
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();
