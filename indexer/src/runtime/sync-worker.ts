import { flushPendingLogReports } from "@artgod/shared/observability/log-reporting";
import { GAP_FILL_MODE } from "@artgod/shared/evm/rpc-budget";
import { SqliteCanonicalChecks } from "../infra/storage/sqlite-canonical-checks.js";
import { connectIndexerRpcBudget } from "./rpc-budget.js";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { BackfillExecutionGate } from "../application/backfill-execution.js";
import {
    createBackfillSyncHandler,
    SYNC_WORKER_LOG_COMPONENT,
} from "../application/backfill-sync-handler.js";
import {
    AutomaticSyncExecutor,
    startAutomaticSyncLoop,
} from "../application/automatic-sync-executor.js";
import { SyncGapScheduler } from "../application/sync-gap-scheduler.js";
import { AutomaticSyncMetrics } from "../infra/observability/automatic-sync-metrics.js";
import { SqliteSyncRangeCommit } from "../infra/storage/sqlite-sync-range-commit.js";
import { SqliteReorgRecoveries } from "../infra/storage/sqlite-reorg-recoveries.js";
import { SqliteQueueOutbox } from "../infra/queue/sqlite-queue-outbox.js";
import { runWorker } from "../application/worker-runner.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { SYNC_JOB_KIND } from "../domain/sync-jobs.js";
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
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
import { initRuntimeApm } from "@artgod/shared/observability/apm";

import { SqliteChainProgress } from "../infra/storage/sqlite-chain-progress.js";
import { SqliteSyncCoordination } from "../infra/storage/sqlite-sync-coordination.js";
import { SqliteOrdersDomain } from "../infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../infra/orders/sqlite-order-validation-demand.js";
import { SqliteMakerRevalidations } from "../infra/orders/sqlite-maker-revalidations.js";
import { RetainCanonicalOrderEffects } from "../application/orders/retain-canonical-order-effects.js";
import { RecoverChainReorg } from "../application/reorg-recovery.js";
import { RollbackChainRange } from "../application/reorg-rollback.js";
import { RpcRollbackOwnershipSnapshot } from "../infra/ownership/rpc-rollback-snapshot.js";
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
            metrics: config.metrics.enabled
                ? runtimeMetrics.metrics
                : undefined,
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
        const canonicalChecks = new SqliteCanonicalChecks();
        const reorgRecoveries = new SqliteReorgRecoveries(
            storage,
            canonicalChecks,
        );
        const outbox = new SqliteQueueOutbox();
        const collectionRegistry = new SqliteCollectionRegistry();
        const progress = new SqliteChainProgress();
        const coordination = new SqliteSyncCoordination(progress);
        const orders = new SqliteOrdersDomain(
            config.tokens.wethAddress,
            config.debugPayloads,
        );
        const demands = new SqliteOrderValidationDemand(orders);
        const makers = new SqliteMakerRevalidations(
            orders,
            demands,
            config.tokens.wethAddress,
        );
        const recovery = new RecoverChainReorg(
            primaryRpc,
            storage,
            reorgRecoveries,
            new RollbackChainRange(
                storage,
                new RpcRollbackOwnershipSnapshot(primaryRpc),
            ),
            canonicalChecks,
            {
                chainId: config.chainId,
                reorgDepth: config.sync.reorgDepth,
                batchSize: config.sync.backfillBatchSize,
            },
        );
        const commit = new SqliteSyncRangeCommit({
            progress,
            orderEffects: new RetainCanonicalOrderEffects({ orders, makers }),
            storage,
            outbox,
            gaps: syncGapStore,
            recoveries: reorgRecoveries,
            collections: collectionRegistry,
        });
        const collectionExtensions = new SqliteCollectionExtensions(
            config.debugPayloads,
        );
        const backfillExecutionGate = new BackfillExecutionGate();

        const automaticSync = startAutomaticSyncLoop(
            new AutomaticSyncExecutor({
                chainId: config.chainId,
                rpc: primaryRpc,
                historicalRpc: backfillRpc,
                progress,
                coordination,
                recovery,
                storage,
                commit,
                canonicalChecks,
                collectionsPort: collectionRegistry,
                collectionExtensions,
                wethAddress: config.tokens.wethAddress,
                gaps: syncGapStore,
                gapWorkEnabled:
                    config.rpc.gapAllocation.mode !== GAP_FILL_MODE.Disabled,
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
                reorgDepth: config.sync.reorgDepth,
                observer: new AutomaticSyncMetrics(runtimeMetrics.metrics),
            }),
        );

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
                if (job.chainId !== config.chainId) return;
                // Sampling retained the target before publication. Deliveries only
                // wake the single owner; they cannot apply individual future blocks.
                automaticSync.wake();
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
                reorgDepth: config.sync.reorgDepth,
                storage,
                commit,
                canonicalChecks,
                collectionsPort: collectionRegistry,
                extensions: collectionExtensions,
                wakeCurrentSync: () => automaticSync.wake(),
                gate: backfillExecutionGate,
            }),
            {
                workScope: rpcAllocation.workScope,
                apm: runtimeApm.apm,
                spanName: "worker.backfillSync.consume",
            },
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
            await Promise.all([
                automaticSync.stop(),
                stopRealtime(),
                stopBackfill(),
            ]);
            flushPendingLogReports();
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
