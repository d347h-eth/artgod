import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { ERC721_ENUMERABLE_ABI } from "../abi/index.js";
import { runWorker } from "../application/worker-runner.js";
import { publishMetadataStatsRecompute } from "../application/metadata/stats-recompute.js";
import { loadConfig } from "../config/index.js";
import type {
    BootstrapMetadataSnapshotMode,
    BootstrapMetadataProcessPayload,
} from "../domain/bootstrap-jobs.js";
import {
    BOOTSTRAP_JOB_KIND,
    type BootstrapBackfillCheckPayload,
    type BootstrapCollectionPayload,
} from "../domain/bootstrap-jobs.js";
import { type JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { getRetryDelayMs, type RetryPolicy } from "../domain/retry.js";
import {
    SYNC_JOB_KIND,
    type BackfillSyncPayload,
} from "../domain/sync-jobs.js";
import { SqliteBootstrapStorage } from "../infra/bootstrap/sqlite.js";
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
import { SqliteMetadataDomain } from "../infra/domain/metadata.js";
import { HttpMetadataFetcher } from "../infra/metadata/http-fetcher.js";
import { ViemTokenUriResolver } from "../infra/metadata/viem-token-uri.js";
import { initRuntimeMetrics } from "../metrics/runtime.js";
import type {
    BootstrapMetadataTask,
    BootstrapMetadataTaskSeed,
    BootstrapSnapshotPort,
} from "../ports/bootstrap.js";
import type { CollectionRegistryPort } from "../ports/collections.js";
import type { MetadataRefreshPayload } from "../domain/domain-jobs.js";
import type { QueuePort } from "../ports/queue.js";
import type { Hex, RpcProviderPort } from "../ports/rpc.js";
import type { StoragePort } from "../ports/storage.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import { SqliteStorage } from "../infra/storage/sqlite.js";

const BOOTSTRAP_BACKFILL_CHECK_DELAY_MS = 5_000;

async function main() {
    try {
        const config = loadConfig();
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.bootstrapWorker,
            worker: "bootstrap-worker",
            chainId: config.chainId,
        });
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
        const queue = await NatsJetStreamQueue.connect({
            natsUrl: config.queue.natsUrl,
            streamPrefix: config.queue.streamPrefix,
        });
        const rpc = new ViemRpcProvider({
            url: config.rpc.primaryUrl,
            logChunkSize: config.sync.logChunkSize,
            metrics: runtimeMetrics.metrics,
            retryPolicy: config.rpc.retryPolicy,
            resilience: config.rpc.resilience,
        });
        const collections = new SqliteCollectionRegistry();
        const bootstrapStorage = new SqliteBootstrapStorage();
        const storage = new SqliteStorage();
        const metadataResolver = new ViemTokenUriResolver({
            url: config.rpc.primaryUrl,
            metrics: runtimeMetrics.metrics,
        });
        const metadataFetcher = new HttpMetadataFetcher({
            metrics: runtimeMetrics.metrics,
        });
        const metadataDomain = new SqliteMetadataDomain(
            metadataResolver,
            metadataFetcher,
        );

        const stop = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.CollectionBootstrap,
                consumerName: `collection-bootstrap-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (
                job: JobEnvelope<
                    | BootstrapCollectionPayload
                    | BootstrapMetadataProcessPayload
                    | BootstrapBackfillCheckPayload
                >,
            ) => {
                if (job.kind === BOOTSTRAP_JOB_KIND.Start) {
                    await handleBootstrapStart(
                        rpc,
                        queue,
                        collections,
                        bootstrapStorage,
                        config.sync.reorgDepth,
                        config.bootstrap.metadataBatchSize,
                        job.payload as BootstrapCollectionPayload,
                        job.traceId ?? job.jobId,
                    );
                    return;
                }

                if (job.kind === BOOTSTRAP_JOB_KIND.MetadataProcess) {
                    await handleBootstrapMetadataProcess(
                        rpc,
                        queue,
                        collections,
                        bootstrapStorage,
                        metadataDomain,
                        config.sync.backfillBatchSize,
                        config.bootstrap.snapshotBatchSize,
                        config.bootstrap.metadataBatchSize,
                        config.bootstrap.metadataConcurrency,
                        config.bootstrap.metadataProcessPollMs,
                        config.bootstrap.metadataRetryPolicy,
                        job.payload as BootstrapMetadataProcessPayload,
                        job.traceId ?? job.jobId,
                        job.jobId,
                    );
                    return;
                }

                if (job.kind === BOOTSTRAP_JOB_KIND.BackfillCheck) {
                    await handleBootstrapBackfillCheck(
                        queue,
                        storage,
                        collections,
                        job.payload as BootstrapBackfillCheckPayload,
                        job.traceId ?? job.jobId,
                        job.jobId,
                    );
                }
            },
        );

        logger.info("Collection bootstrap worker ready", {
            component: "CollectionBootstrapWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Collection bootstrap worker shutting down", {
                component: "CollectionBootstrapWorker",
                action: "shutdown",
            });
            await stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        process.stdin.resume();
    } catch (error) {
        logger.error("Collection bootstrap worker startup failed", {
            component: "CollectionBootstrapWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();

async function handleBootstrapStart(
    rpc: RpcProviderPort,
    queue: QueuePort,
    collections: CollectionRegistryPort,
    bootstrapStorage: BootstrapSnapshotPort,
    reorgDepth: number,
    metadataBatchSize: number,
    payload: BootstrapCollectionPayload,
    traceId: string,
): Promise<void> {
    // Bootstrap orchestration entrypoint: validate scope before metadata/snapshot/backfill steps.
    if (payload.standard !== "erc721") {
        logger.warn("Bootstrap skipped (unsupported standard)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            address: payload.address,
            standard: payload.standard,
            reason: payload.reason,
        });
        return;
    }

    const anchorBlock = await resolveAnchorBlock(rpc, reorgDepth);
    if (anchorBlock === null) {
        logger.warn("Bootstrap skipped (invalid anchor block)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            address: payload.address,
            standard: payload.standard,
            reason: payload.reason,
        });
        return;
    }

    const anchor = await rpc.getBlock(anchorBlock);
    const updated = collections.markBootstrapStarted(
        payload.chainId,
        payload.collectionId,
        anchorBlock,
    );
    if (!updated) {
        logger.warn("Bootstrap skipped (collection missing)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            address: payload.address,
            standard: payload.standard,
            reason: payload.reason,
            anchorBlock,
        });
        return;
    }

    try {
        bootstrapStorage.resetSnapshot(payload.chainId, payload.collectionId);
        bootstrapStorage.resetMetadataTasks(
            payload.chainId,
            payload.collectionId,
        );

        const tokenIds = await enumerateTokenIds(
            rpc,
            payload.address as Hex,
            anchorBlock,
        );
        const writeBatchSize = Math.max(1, metadataBatchSize);
        const normalizedContract = payload.address.toLowerCase();
        // Intentionally split inserts into multiple transactions so large collections
        // do not create one huge SQLite write transaction during bootstrap start.
        for (let cursor = 0; cursor < tokenIds.length; cursor += writeBatchSize) {
            const end = Math.min(tokenIds.length, cursor + writeBatchSize);
            const rows: BootstrapMetadataTaskSeed[] = [];
            for (let index = cursor; index < end; index += 1) {
                rows.push({
                    chainId: payload.chainId,
                    collectionId: payload.collectionId,
                    contract: normalizedContract,
                    tokenId: tokenIds[index],
                    standard: "erc721",
                    anchorBlock,
                    anchorHash: anchor.hash,
                    anchorTimestamp: anchor.timestamp,
                });
            }
            bootstrapStorage.insertMetadataTasks(rows);
        }

        await scheduleMetadataProcess(
            queue,
            {
                chainId: payload.chainId,
                collectionId: payload.collectionId,
                address: payload.address,
                standard: payload.standard,
                metadataSnapshotMode: payload.metadataSnapshotMode,
                anchorBlock,
                anchorHash: anchor.hash,
                anchorTimestamp: anchor.timestamp,
            },
            traceId,
            0,
        );

        logger.info("Bootstrap metadata phase queued", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            address: payload.address,
            standard: payload.standard,
            anchorBlock,
            metadataMode: payload.metadataSnapshotMode,
            tokenCount: tokenIds.length,
        });
    } catch (error) {
        logger.error("Bootstrap start failed", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            address: payload.address,
            standard: payload.standard,
            anchorBlock,
            error: String(error),
        });
        throw error;
    }
}

async function handleBootstrapMetadataProcess(
    rpc: RpcProviderPort,
    queue: QueuePort,
    collections: CollectionRegistryPort,
    bootstrapStorage: BootstrapSnapshotPort,
    metadataDomain: SqliteMetadataDomain,
    backfillBatchSize: number,
    snapshotBatchSize: number,
    metadataBatchSize: number,
    metadataConcurrency: number,
    metadataPollMs: number,
    metadataRetryPolicy: RetryPolicy,
    payload: BootstrapMetadataProcessPayload,
    traceId: string,
    sourceJobId: string,
): Promise<void> {
    if (payload.standard !== "erc721") {
        logger.warn("Metadata process skipped (unsupported standard)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapMetadataProcess",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            standard: payload.standard,
        });
        return;
    }

    const collection = collections.getCollection(
        payload.chainId,
        payload.collectionId,
    );
    if (!collection) {
        logger.warn("Metadata process skipped (collection missing)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapMetadataProcess",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return;
    }

    if (collection.status === "live") {
        logger.debug("Metadata process skipped (collection already live)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapMetadataProcess",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return;
    }

    const processed = await processDueMetadataTasks(
        bootstrapStorage,
        metadataDomain,
        payload,
        metadataBatchSize,
        metadataConcurrency,
        metadataRetryPolicy,
    );

    const counts = bootstrapStorage.getMetadataTaskCounts(
        payload.chainId,
        payload.collectionId,
    );
    const complete = isMetadataSnapshotComplete(
        counts,
        payload.metadataSnapshotMode,
    );
    if (!complete) {
        const hasDueNow =
            bootstrapStorage.listMetadataTasksDueNow(
                payload.chainId,
                payload.collectionId,
                Date.now(),
                1,
            ).length > 0;

        await scheduleMetadataProcess(
            queue,
            payload,
            traceId,
            hasDueNow ? 0 : Math.max(1, metadataPollMs),
        );

        logger.debug("Bootstrap metadata process progress", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapMetadataProcess",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            mode: payload.metadataSnapshotMode,
            processed,
            counts,
            nextDelayMs: hasDueNow ? 0 : Math.max(1, metadataPollMs),
        });
        return;
    }

    // Metadata snapshot is complete. If owner snapshot was not finalized yet,
    // build ownership baseline from the same token set and anchor block.
    if (
        collection.bootstrapLastSyncedBlock === null ||
        collection.bootstrapLastSyncedBlock < payload.anchorBlock
    ) {
        const tokenIds = bootstrapStorage.listMetadataTaskTokenIds(
            payload.chainId,
            payload.collectionId,
        );
        await snapshotOwners(
            rpc,
            bootstrapStorage,
            payload.chainId,
            payload.collectionId,
            payload.address,
            payload.anchorBlock,
            tokenIds,
            snapshotBatchSize,
        );

        bootstrapStorage.finalizeSnapshot({
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            contract: payload.address,
            anchorBlock: payload.anchorBlock,
            anchorHash: payload.anchorHash as Hex,
            anchorTimestamp: payload.anchorTimestamp,
        });
        collections.markBootstrapSnapshotProgress(
            payload.chainId,
            payload.collectionId,
            payload.anchorBlock,
        );

        logger.info("Bootstrap owner snapshot completed", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapMetadataProcess",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            anchorBlock: payload.anchorBlock,
            tokenCount: tokenIds.length,
        });
    }

    await ensureBackfillScheduled(
        rpc,
        queue,
        collections,
        payload,
        backfillBatchSize,
        traceId,
        sourceJobId,
    );
}

async function processDueMetadataTasks(
    bootstrapStorage: BootstrapSnapshotPort,
    metadataDomain: SqliteMetadataDomain,
    payload: BootstrapMetadataProcessPayload,
    metadataBatchSize: number,
    metadataConcurrency: number,
    metadataRetryPolicy: RetryPolicy,
): Promise<number> {
    const dueTasks = bootstrapStorage.listMetadataTasksDueNow(
        payload.chainId,
        payload.collectionId,
        Date.now(),
        Math.max(1, metadataBatchSize),
    );
    if (dueTasks.length === 0) {
        return 0;
    }

    await mapWithConcurrency(
        dueTasks,
        Math.max(1, metadataConcurrency),
        async (task) => {
            await processSingleMetadataTask(
                bootstrapStorage,
                metadataDomain,
                payload,
                task,
                metadataRetryPolicy,
            );
        },
    );

    return dueTasks.length;
}

async function processSingleMetadataTask(
    bootstrapStorage: BootstrapSnapshotPort,
    metadataDomain: SqliteMetadataDomain,
    payload: BootstrapMetadataProcessPayload,
    task: BootstrapMetadataTask,
    metadataRetryPolicy: RetryPolicy,
): Promise<void> {
    const attempts = task.attempts + 1;
    try {
        const refreshPayload: MetadataRefreshPayload = {
            chainId: payload.chainId,
            contract: payload.address.toLowerCase(),
            tokenId: task.tokenId,
            standard: "erc721",
            metadataUrl: null,
            blockNumber: payload.anchorBlock,
            blockHash: payload.anchorHash,
            blockTimestamp: payload.anchorTimestamp,
            reason: "bootstrap-snapshot",
            source: "bootstrap",
        };
        const updated =
            await metadataDomain.handleMetadataRefresh(refreshPayload);
        if (updated) {
            bootstrapStorage.markMetadataTaskSucceeded(
                task.chainId,
                task.collectionId,
                task.tokenId,
                attempts,
            );
            return;
        }

        markMetadataTaskFailed(
            bootstrapStorage,
            payload.metadataSnapshotMode,
            task,
            attempts,
            metadataRetryPolicy,
            "Metadata URI or payload unavailable",
        );
    } catch (error) {
        markMetadataTaskFailed(
            bootstrapStorage,
            payload.metadataSnapshotMode,
            task,
            attempts,
            metadataRetryPolicy,
            String(error),
        );
    }
}

function markMetadataTaskFailed(
    bootstrapStorage: BootstrapSnapshotPort,
    mode: BootstrapMetadataSnapshotMode,
    task: BootstrapMetadataTask,
    attempts: number,
    retryPolicy: RetryPolicy,
    error: string,
): void {
    const failedTerminal =
        mode === "best_effort" &&
        attempts >= Math.max(1, retryPolicy.maxAttempts);
    const retryDelay = getRetryDelayMs(attempts, retryPolicy);
    const nextAttemptAt = failedTerminal ? 0 : Date.now() + retryDelay;

    bootstrapStorage.markMetadataTaskRetry(
        task.chainId,
        task.collectionId,
        task.tokenId,
        attempts,
        nextAttemptAt,
        error,
        failedTerminal,
    );
}

function isMetadataSnapshotComplete(
    counts: {
        pending: number;
        retry: number;
        failedTerminal: number;
    },
    mode: BootstrapMetadataSnapshotMode,
): boolean {
    if (mode === "strict") {
        return (
            counts.pending === 0 &&
            counts.retry === 0 &&
            counts.failedTerminal === 0
        );
    }
    return counts.pending === 0 && counts.retry === 0;
}

async function ensureBackfillScheduled(
    rpc: RpcProviderPort,
    queue: QueuePort,
    collections: CollectionRegistryPort,
    payload: BootstrapMetadataProcessPayload,
    backfillBatchSize: number,
    traceId: string,
    sourceJobId: string,
): Promise<void> {
    const fromBlock = payload.anchorBlock + 1;
    if (fromBlock <= 0) {
        logger.warn("Bootstrap backfill skipped (invalid range)", {
            component: "CollectionBootstrapWorker",
            action: "ensureBackfillScheduled",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            fromBlock,
            anchorBlock: payload.anchorBlock,
        });
        return;
    }

    const head = await rpc.getBlockNumber();
    if (head < fromBlock) {
        const updated = collections.markBootstrapFinished(
            payload.chainId,
            payload.collectionId,
            payload.anchorBlock,
        );
        if (updated) {
            await publishMetadataStatsRecompute(
                queue,
                {
                    chainId: payload.chainId,
                    contract: payload.address,
                    reason: "bootstrap-finalized",
                    sourceJobId,
                },
                traceId,
            );
        }

        logger.info("Bootstrap finished (no post-anchor blocks)", {
            component: "CollectionBootstrapWorker",
            action: "ensureBackfillScheduled",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            anchorBlock: payload.anchorBlock,
            head,
        });
        return;
    }

    await scheduleBackfillRange(
        queue,
        payload.chainId,
        payload.collectionId,
        fromBlock,
        head,
        backfillBatchSize,
    );
    await scheduleBackfillCheck(queue, {
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        address: payload.address,
        fromBlock,
        toBlock: head,
    });

    logger.info("Bootstrap backfill queued", {
        component: "CollectionBootstrapWorker",
        action: "ensureBackfillScheduled",
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        fromBlock,
        toBlock: head,
    });
}

async function handleBootstrapBackfillCheck(
    queue: QueuePort,
    storage: StoragePort,
    collections: CollectionRegistryPort,
    payload: BootstrapBackfillCheckPayload,
    traceId: string,
    sourceJobId: string,
): Promise<void> {
    const expected = payload.toBlock - payload.fromBlock + 1;
    if (expected <= 0) {
        logger.warn("Bootstrap backfill check skipped (invalid range)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapBackfillCheck",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            fromBlock: payload.fromBlock,
            toBlock: payload.toBlock,
        });
        return;
    }

    const count = storage.countBlocksInRange(
        payload.chainId,
        payload.fromBlock,
        payload.toBlock,
    );
    if (count < expected) {
        logger.debug("Bootstrap backfill incomplete; retrying", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapBackfillCheck",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            fromBlock: payload.fromBlock,
            toBlock: payload.toBlock,
            count,
            expected,
        });
        await scheduleBackfillCheck(queue, payload);
        return;
    }

    const updated = collections.markBootstrapFinished(
        payload.chainId,
        payload.collectionId,
        payload.toBlock,
    );
    if (!updated) {
        logger.warn("Bootstrap finish skipped (collection missing)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapBackfillCheck",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            fromBlock: payload.fromBlock,
            toBlock: payload.toBlock,
        });
        return;
    }

    logger.info("Bootstrap backfill complete; collection live", {
        component: "CollectionBootstrapWorker",
        action: "handleBootstrapBackfillCheck",
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        fromBlock: payload.fromBlock,
        toBlock: payload.toBlock,
    });

    await publishMetadataStatsRecompute(
        queue,
        {
            chainId: payload.chainId,
            contract: payload.address,
            reason: "bootstrap-finalized",
            sourceJobId,
        },
        traceId,
    );
}

async function scheduleMetadataProcess(
    queue: QueuePort,
    payload: BootstrapMetadataProcessPayload,
    traceId: string,
    delayMs: number,
): Promise<void> {
    const nonce = Math.floor(Math.random() * 1_000_000_000);
    const scheduledAt = Date.now() + Math.max(0, delayMs);
    const job: JobEnvelope<BootstrapMetadataProcessPayload> = {
        jobId: `bootstrap:metadata:${payload.chainId}:${payload.collectionId}:${scheduledAt}:${nonce}`,
        kind: BOOTSTRAP_JOB_KIND.MetadataProcess,
        queue: QUEUE_NAMES.CollectionBootstrap,
        payload,
        attempt: 0,
        scheduledAt,
        chainId: payload.chainId,
        traceId,
        collectionId: payload.collectionId,
    };
    await queue.publish(QUEUE_NAMES.CollectionBootstrap, job);
}

async function scheduleBackfillRange(
    queue: QueuePort,
    chainId: number,
    collectionId: string,
    fromBlock: number,
    toBlock: number,
    batchSize: number,
): Promise<void> {
    const size = Math.max(1, batchSize);
    for (let start = fromBlock; start <= toBlock; start += size) {
        const end = Math.min(toBlock, start + size - 1);
        const job: JobEnvelope<BackfillSyncPayload> = {
            // Deterministic id keeps this scheduling idempotent.
            jobId: `sync:bootstrap:${chainId}:${collectionId}:${start}-${end}`,
            kind: SYNC_JOB_KIND.BackfillRange,
            queue: QUEUE_NAMES.BackfillSync,
            payload: { fromBlock: start, toBlock: end },
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
            collectionId,
        };
        await queue.publish(QUEUE_NAMES.BackfillSync, job);
    }
}

async function scheduleBackfillCheck(
    queue: QueuePort,
    payload: BootstrapBackfillCheckPayload,
): Promise<void> {
    const job: JobEnvelope<BootstrapBackfillCheckPayload> = {
        jobId: `bootstrap:check:${payload.chainId}:${payload.collectionId}:${Date.now()}`,
        kind: BOOTSTRAP_JOB_KIND.BackfillCheck,
        queue: QUEUE_NAMES.CollectionBootstrap,
        payload,
        attempt: 0,
        scheduledAt: Date.now() + BOOTSTRAP_BACKFILL_CHECK_DELAY_MS,
        chainId: payload.chainId,
    };
    await queue.publish(QUEUE_NAMES.CollectionBootstrap, job);
}

async function resolveAnchorBlock(
    rpc: RpcProviderPort,
    reorgDepth: number,
): Promise<number | null> {
    // Anchor uses a confirmed head to avoid snapshots on reorg-prone blocks.
    const head = await rpc.getBlockNumber();
    const anchor = head - Math.max(0, reorgDepth);
    if (anchor < 1) return null;
    return anchor;
}

async function enumerateTokenIds(
    rpc: RpcProviderPort,
    contract: Hex,
    anchorBlock: number,
): Promise<string[]> {
    // ERC721Enumerable is required for snapshot enumeration.
    const totalSupply = await rpc.readContract<bigint>({
        address: contract,
        abi: ERC721_ENUMERABLE_ABI,
        functionName: "totalSupply",
        blockNumber: anchorBlock,
    });
    const supply = Number(totalSupply);
    if (!Number.isSafeInteger(supply) || supply < 0) {
        throw new Error(`Invalid totalSupply: ${String(totalSupply)}`);
    }
    const tokenIds: string[] = [];
    for (let index = 0; index < supply; index += 1) {
        const tokenId = await rpc.readContract<bigint>({
            address: contract,
            abi: ERC721_ENUMERABLE_ABI,
            functionName: "tokenByIndex",
            args: [BigInt(index)],
            blockNumber: anchorBlock,
        });
        tokenIds.push(tokenId.toString());
    }
    return tokenIds;
}

async function snapshotOwners(
    rpc: RpcProviderPort,
    bootstrapStorage: BootstrapSnapshotPort,
    chainId: number,
    collectionId: string,
    contract: string,
    anchorBlock: number,
    tokenIds: string[],
    batchSize: number,
): Promise<void> {
    // Snapshot ownership at the anchor block and write to the temporary snapshot table.
    const batch: Array<{
        chainId: number;
        collectionId: string;
        contract: string;
        tokenId: string;
        owner: string;
        anchorBlock: number;
    }> = [];
    const flush = () => {
        if (batch.length === 0) return;
        bootstrapStorage.insertSnapshotRows(batch.splice(0, batch.length));
    };

    for (const tokenId of tokenIds) {
        const owner = await rpc.readContract<string>({
            address: contract as Hex,
            abi: ERC721_ENUMERABLE_ABI,
            functionName: "ownerOf",
            args: [BigInt(tokenId)],
            blockNumber: anchorBlock,
        });
        batch.push({
            chainId,
            collectionId,
            contract,
            tokenId,
            owner,
            anchorBlock,
        });
        if (batch.length >= Math.max(1, batchSize)) {
            flush();
        }
    }
    flush();
}

async function mapWithConcurrency<T>(
    items: T[],
    limit: number,
    handler: (item: T) => Promise<void>,
): Promise<void> {
    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, limit) }, async () => {
        for (;;) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) {
                return;
            }
            await handler(items[index]);
        }
    });
    await Promise.all(workers);
}
