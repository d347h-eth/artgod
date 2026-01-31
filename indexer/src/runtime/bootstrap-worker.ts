import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { ERC721_ENUMERABLE_ABI } from "../abi/index.js";
import { runWorker } from "../application/worker-runner.js";
import type { JobEnvelope } from "../domain/jobs.js";
import {
    BOOTSTRAP_JOB_KIND,
    type BootstrapBackfillCheckPayload,
    type BootstrapCollectionPayload,
} from "../domain/bootstrap-jobs.js";
import {
    SYNC_JOB_KIND,
    type BackfillSyncPayload,
} from "../domain/sync-jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
import { SqliteBootstrapStorage } from "../infra/bootstrap/sqlite.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import type { BootstrapSnapshotPort } from "../ports/bootstrap.js";
import type { CollectionRegistryPort } from "../ports/collections.js";
import type { Hex, RpcProviderPort } from "../ports/rpc.js";
import { SqliteStorage } from "../infra/storage/sqlite.js";
import type { QueuePort } from "../ports/queue.js";
import type { StoragePort } from "../ports/storage.js";

const BOOTSTRAP_BACKFILL_CHECK_DELAY_MS = 5_000;

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
        });
        const collections = new SqliteCollectionRegistry();
        const bootstrapStorage = new SqliteBootstrapStorage();
        const storage = new SqliteStorage();

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
                    BootstrapCollectionPayload | BootstrapBackfillCheckPayload
                >,
            ) => {
                if (job.kind === BOOTSTRAP_JOB_KIND.Start) {
                    await handleBootstrapStart(
                        rpc,
                        queue,
                        collections,
                        bootstrapStorage,
                        config.sync.reorgDepth,
                        config.sync.backfillBatchSize,
                        config.bootstrap.snapshotBatchSize,
                        job.payload as BootstrapCollectionPayload,
                    );
                    return;
                }
                if (job.kind === BOOTSTRAP_JOB_KIND.BackfillCheck) {
                    await handleBootstrapBackfillCheck(
                        queue,
                        storage,
                        collections,
                        job.payload as BootstrapBackfillCheckPayload,
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
    backfillBatchSize: number,
    snapshotBatchSize: number,
    payload: BootstrapCollectionPayload,
): Promise<void> {
    // Bootstrap orchestration entrypoint: validate scope before snapshot/backfill steps.
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

        const tokenIds = await enumerateTokenIds(
            rpc,
            payload.address as Hex,
            anchorBlock,
        );
        await snapshotOwners(
            rpc,
            bootstrapStorage,
            payload.chainId,
            payload.collectionId,
            payload.address,
            anchorBlock,
            tokenIds,
            snapshotBatchSize,
        );

        bootstrapStorage.finalizeSnapshot({
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            contract: payload.address,
            anchorBlock,
            anchorHash: anchor.hash,
            anchorTimestamp: anchor.timestamp,
        });
        collections.markBootstrapSnapshotProgress(
            payload.chainId,
            payload.collectionId,
            anchorBlock,
        );

        const head = await rpc.getBlockNumber();
        const fromBlock = anchorBlock + 1;
        if (fromBlock <= 0) {
            logger.warn("Bootstrap backfill skipped (invalid range)", {
                component: "CollectionBootstrapWorker",
                action: "handleBootstrapStart",
                chainId: payload.chainId,
                collectionId: payload.collectionId,
                address: payload.address,
                standard: payload.standard,
                anchorBlock,
                head,
            });
        } else if (head < fromBlock) {
            collections.markBootstrapFinished(
                payload.chainId,
                payload.collectionId,
                anchorBlock,
            );
            logger.info("Bootstrap backfill skipped (no new blocks)", {
                component: "CollectionBootstrapWorker",
                action: "handleBootstrapStart",
                chainId: payload.chainId,
                collectionId: payload.collectionId,
                address: payload.address,
                standard: payload.standard,
                anchorBlock,
                head,
            });
        } else {
            await scheduleBackfillRange(
                queue,
                payload.chainId,
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
        }

        logger.info("Bootstrap snapshot completed", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            address: payload.address,
            standard: payload.standard,
            anchorBlock,
            tokenCount: tokenIds.length,
        });
    } catch (error) {
        logger.error("Bootstrap snapshot failed", {
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

async function handleBootstrapBackfillCheck(
    queue: QueuePort,
    storage: StoragePort,
    collections: CollectionRegistryPort,
    payload: BootstrapBackfillCheckPayload,
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
            jobId: `sync:bootstrap:${chainId}:${start}-${end}:${Date.now()}`,
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
