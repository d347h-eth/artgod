import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { runWorker } from "../application/worker-runner.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import {
    REORG_JOB_KIND,
    type BlockCheckPayload,
} from "../domain/reorg-jobs.js";
import {
    SYNC_JOB_KIND,
    type BackfillSyncPayload,
} from "../domain/sync-jobs.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import { SqliteStorage } from "../infra/storage/sqlite.js";
import type { RpcProviderPort } from "../ports/rpc.js";
import type { QueuePort } from "../ports/queue.js";
import type { StoragePort } from "../ports/storage.js";

async function main() {
    try {
        const config = loadConfig();
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const rpc = new ViemRpcProvider({
            url: config.rpc.primaryUrl,
            logChunkSize: config.sync.logChunkSize,
            retryPolicy: config.rpc.retryPolicy,
            resilience: config.rpc.resilience,
        });
        const storage = new SqliteStorage();

        const stop = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.BlockCheck,
                consumerName: `reorg-check-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<BlockCheckPayload>) => {
                if (job.kind !== REORG_JOB_KIND.BlockCheck) return;
                await handleBlockCheck(
                    queue,
                    rpc,
                    storage,
                    config.chainId,
                    config.sync.reorgDepth,
                    config.sync.backfillBatchSize,
                    job.payload.blockNumber,
                );
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
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        process.stdin.resume();
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

async function handleBlockCheck(
    queue: QueuePort,
    rpc: RpcProviderPort,
    storage: StoragePort,
    chainId: number,
    reorgDepth: number,
    backfillBatchSize: number,
    blockNumber: number,
): Promise<void> {
    if (blockNumber <= 0) {
        logger.warn("Block check skipped (non-positive block)", {
            component: "IndexerReorgWorker",
            action: "blockCheck",
            blockNumber,
        });
        return;
    }

    const storedHash = storage.getBlockHash(chainId, blockNumber);
    if (!storedHash) {
        logger.debug("Block check skipped (missing DB hash)", {
            component: "IndexerReorgWorker",
            action: "blockCheck",
            blockNumber,
        });
        return;
    }

    const rpcBlock = await rpc.getBlock(blockNumber);
    if (rpcBlock.hash === storedHash) {
        logger.debug("Block check ok", {
            component: "IndexerReorgWorker",
            action: "blockCheck",
            blockNumber,
        });
        return;
    }

    const forkPoint = await findForkPoint(
        rpc,
        storage,
        chainId,
        blockNumber,
        reorgDepth,
    );
    if (forkPoint < 0) {
        logger.warn("Reorg rollback skipped (invalid fork point)", {
            component: "IndexerReorgWorker",
            action: "blockCheck",
            blockNumber,
            forkPoint,
        });
        return;
    }
    const rollbackFrom = forkPoint + 1;
    if (rollbackFrom <= 0) {
        logger.warn("Reorg rollback skipped (non-positive rollback)", {
            component: "IndexerReorgWorker",
            action: "blockCheck",
            blockNumber,
            forkPoint,
            rollbackFrom,
        });
        return;
    }
    storage.rollbackFromBlock(chainId, rollbackFrom);

    const head = await rpc.getBlockNumber();
    await scheduleBackfillRange(
        queue,
        chainId,
        rollbackFrom,
        head,
        backfillBatchSize,
    );

    logger.warn("Reorg rollback scheduled", {
        component: "IndexerReorgWorker",
        action: "blockCheck",
        blockNumber,
        forkPoint,
        rollbackFrom,
        head,
    });
}

async function findForkPoint(
    rpc: RpcProviderPort,
    storage: StoragePort,
    chainId: number,
    startBlock: number,
    reorgDepth: number,
): Promise<number> {
    const depth = Math.max(1, reorgDepth);
    const minBlock = startBlock - depth;
    if (minBlock < 0) return -1;
    for (let block = startBlock - 1; block >= minBlock; block -= 1) {
        const storedHash = storage.getBlockHash(chainId, block);
        if (!storedHash) return block - 1;
        const rpcBlock = await rpc.getBlock(block);
        if (rpcBlock.hash === storedHash) {
            return block;
        }
    }
    return minBlock - 1;
}

async function scheduleBackfillRange(
    queue: QueuePort,
    chainId: number,
    fromBlock: number,
    toBlock: number,
    batchSize: number,
): Promise<void> {
    const size = Math.max(1, batchSize);
    for (let start = fromBlock; start <= toBlock; start += size) {
        const end = Math.min(toBlock, start + size - 1);
        const job: JobEnvelope<BackfillSyncPayload> = {
            jobId: `sync:reorg:${chainId}:${start}-${end}:${Date.now()}`,
            kind: SYNC_JOB_KIND.BackfillRange,
            queue: QUEUE_NAMES.BackfillSync,
            payload: { fromBlock: start, toBlock: end },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
        };
        await queue.publish(QUEUE_NAMES.BackfillSync, job);
    }
}
