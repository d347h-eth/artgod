import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { runWorker } from "../application/worker-runner.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import {
    REORG_JOB_KIND,
    type BlockCheckPayload,
} from "../domain/reorg-jobs.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import {
    INDEXER_RPC_ENDPOINT_ID_PREFIX,
    INDEXER_RPC_OBSERVABILITY_COMPONENT,
} from "../infra/rpc/observability.js";
import { SqliteStorage } from "../infra/storage/sqlite.js";
import { SqliteReorgRecoveries } from "../infra/storage/sqlite-reorg-recoveries.js";
import { SqliteQueueOutbox } from "../infra/queue/sqlite-queue-outbox.js";
import {
    RecoverChainReorg,
    startReorgRecoveryLoop,
} from "../application/reorg-recovery.js";
import { REORG_RECOVERY_POLICY } from "../domain/reorg-recovery.js";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import { initRuntimeApm } from "@artgod/shared/observability/apm";
import { RollbackChainRange } from "../application/reorg-rollback.js";
import { RpcRollbackOwnershipSnapshot } from "../infra/ownership/rpc-rollback-snapshot.js";

async function main() {
    try {
        const config = loadConfig();
        setDbPath(config.dbPath);
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "reorg-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.reorgWorker,
            worker: "reorg-worker",
            chainId: config.chainId,
        });
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const rpc = new ViemRpcProvider({
            endpoints: config.rpc.endpoints,
            logChunkSize: config.sync.logChunkSize,
            metrics: runtimeMetrics.metrics,
            component: INDEXER_RPC_OBSERVABILITY_COMPONENT.ReorgHttp,
            endpointIdPrefix: INDEXER_RPC_ENDPOINT_ID_PREFIX.ReorgHttp,
            retryPolicy: config.rpc.retryPolicy,
            resilience: config.rpc.resilience,
        });
        const storage = new SqliteStorage();
        const rollback = new RollbackChainRange(
            storage,
            new RpcRollbackOwnershipSnapshot(rpc),
        );

        const recovery = new RecoverChainReorg(
            rpc,
            storage,
            new SqliteReorgRecoveries(storage, new SqliteQueueOutbox()),
            rollback,
            {
                chainId: config.chainId,
                reorgDepth: config.sync.reorgDepth,
                batchSize: config.sync.backfillBatchSize,
            },
        );
        const stopRecoveryLoop = startReorgRecoveryLoop(recovery);
        const stop = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.BlockCheck,
                consumerName: `reorg-check-${config.chainId}`,
                maxInFlight: 1,
                extendLeaseMs: REORG_RECOVERY_POLICY.LeaseExtensionMs,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<BlockCheckPayload>) => {
                if (job.kind !== REORG_JOB_KIND.BlockCheck) return;
                if (job.chainId !== config.chainId) return;
                await recovery.checkBlock(job.payload.blockNumber);
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.reorgCheck.consume",
            },
        );

        logger.info("Reorg worker ready", {
            component: "IndexerReorgWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Reorg worker shutting down", {
                component: "IndexerReorgWorker",
                action: "shutdown",
            });
            await stop();
            await stopRecoveryLoop();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    } catch (error) {
        logger.error("Reorg worker startup failed", {
            component: "IndexerReorgWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();
