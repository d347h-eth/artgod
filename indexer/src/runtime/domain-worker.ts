import { createMigrationRunner } from "@artgod/shared/migrations";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { runWorker } from "../application/worker-runner.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import {
    DOMAIN_JOB_KIND,
    type DomainSyncPayload,
    type MetadataRefreshPayload,
    type MetadataRefreshRangePayload,
} from "../domain/domain-jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { SqliteOrdersDomain } from "../infra/domain/orders.js";
import type { DomainSyncContext } from "../ports/domain-handlers.js";
import { SqliteMetadataDomain } from "../infra/domain/metadata.js";
import { HttpMetadataFetcher } from "../infra/metadata/http-fetcher.js";
import { ViemTokenUriResolver } from "../infra/metadata/viem-token-uri.js";
import { noopMetrics } from "../metrics/noop.js";
import { SqliteActivityDomain } from "../infra/domain/activities.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import { SqliteConduitRegistry } from "../infra/conduits/sqlite.js";
import type { QueuePort } from "../ports/queue.js";
import {
    ORDER_JOB_KIND,
    type OrderUpdateByIdPayload,
    type OrderUpdateByMakerPayload,
    type OrderUpsertPayload,
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
        const rpc = new ViemRpcProvider({
            url: config.rpc.primaryUrl,
            logChunkSize: config.sync.logChunkSize,
        });
        const conduits = new SqliteConduitRegistry();
        const ordersDomain = new SqliteOrdersDomain(
            rpc,
            conduits,
            config.seaport,
        );
        const metadataResolver = new ViemTokenUriResolver({
            url: config.rpc.primaryUrl,
            metrics: noopMetrics,
        });
        const metadataFetcher = new HttpMetadataFetcher({
            metrics: noopMetrics,
        });
        const metadataDomain = new SqliteMetadataDomain(
            metadataResolver,
            metadataFetcher,
        );
        const activityDomain = new SqliteActivityDomain();

        const stopOrders = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OrdersDomain,
                consumerName: `orders-domain-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<DomainSyncPayload>) => {
                if (job.kind !== DOMAIN_JOB_KIND.OrdersSync) return;
                await ordersDomain.handleDomainSync(toDomainContext(job));
            },
        );

        const stopOrderUpdatesByMaker = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OrdersUpdateByMaker,
                consumerName: `orders-update-by-maker-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<OrderUpdateByMakerPayload>) => {
                if (job.kind !== ORDER_JOB_KIND.UpdateByMaker) return;
                await ordersDomain.handleOrderUpdateByMaker(job.payload);
            },
        );

        const stopOrderUpdatesById = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OrdersUpdateById,
                consumerName: `orders-update-by-id-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<OrderUpdateByIdPayload>) => {
                if (job.kind !== ORDER_JOB_KIND.UpdateById) return;
                await ordersDomain.handleOrderUpdateById(job.payload);
            },
        );

        const stopOrderUpserts = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OrdersUpsert,
                consumerName: `orders-upsert-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<OrderUpsertPayload>) => {
                if (job.kind !== ORDER_JOB_KIND.Upsert) return;
                await ordersDomain.handleOrderUpsert(job.payload);
                if (job.payload.validateAfterUpsert) {
                    const validationJob: JobEnvelope<OrderUpdateByIdPayload> = {
                        jobId: `orders:update:id:upsert:${job.payload.chainId}:${job.payload.orderId}:${job.jobId}`,
                        kind: ORDER_JOB_KIND.UpdateById,
                        queue: QUEUE_NAMES.OrdersUpdateById,
                        payload: {
                            chainId: job.payload.chainId,
                            orderId: job.payload.orderId,
                            reason: "order",
                            blockNumber: 0,
                            blockHash: "0x0",
                            txHash: "0x0",
                            logIndex: 0,
                        },
                        attempt: 0,
                        scheduledAt: Date.now(),
                        chainId: job.payload.chainId,
                        traceId: job.traceId ?? job.jobId,
                    };
                    await queue.publish(
                        QUEUE_NAMES.OrdersUpdateById,
                        validationJob,
                    );
                }
            },
        );

        const stopMetadata = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.MetadataDomain,
                consumerName: `metadata-domain-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<DomainSyncPayload>) => {
                if (job.kind !== DOMAIN_JOB_KIND.MetadataSync) return;
                await metadataDomain.handleDomainSync(toDomainContext(job));
            },
        );

        const stopMetadataRefresh = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.MetadataRefresh,
                consumerName: `metadata-refresh-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (
                job: JobEnvelope<
                    MetadataRefreshPayload | MetadataRefreshRangePayload
                >,
            ) => {
                if (job.kind === DOMAIN_JOB_KIND.MetadataRefresh) {
                    await metadataDomain.handleMetadataRefresh(
                        job.payload as MetadataRefreshPayload,
                    );
                    return;
                }
                if (job.kind === DOMAIN_JOB_KIND.MetadataRefreshRange) {
                    await handleMetadataRefreshRangeJob(
                        queue,
                        metadataDomain,
                        job.payload as MetadataRefreshRangePayload,
                        config.metadata.refreshRangeChunkSize,
                        job.traceId ?? job.jobId,
                    );
                }
            },
        );

        const stopActivity = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.ActivityDomain,
                consumerName: `activity-domain-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<DomainSyncPayload>) => {
                if (job.kind !== DOMAIN_JOB_KIND.ActivitySync) return;
                await activityDomain.handleDomainSync(toDomainContext(job));
            },
        );

        logger.info("Domain worker ready", {
            component: "IndexerDomainWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Domain worker shutting down", {
                component: "IndexerDomainWorker",
                action: "shutdown",
            });
            await stopOrders();
            await stopOrderUpdatesByMaker();
            await stopOrderUpdatesById();
            await stopOrderUpserts();
            await stopMetadata();
            await stopMetadataRefresh();
            await stopActivity();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
        process.stdin.resume();
    } catch (error) {
        logger.error("Domain worker startup failed", {
            component: "IndexerDomainWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();

async function handleMetadataRefreshRangeJob(
    queue: QueuePort,
    metadataDomain: SqliteMetadataDomain,
    payload: MetadataRefreshRangePayload,
    chunkSize: number,
    traceId: string,
): Promise<void> {
    const contract = payload.contract.toLowerCase();
    const { tokenIds, nextCursorTokenId } = chunkTokenIdRange(
        payload.fromTokenId,
        payload.toTokenId,
        payload.cursorTokenId,
        chunkSize,
    );

    for (const tokenId of tokenIds) {
        await metadataDomain.handleMetadataRefresh({
            chainId: payload.chainId,
            contract,
            tokenId,
            metadataUrl: null,
            reason: payload.reason,
            source: payload.source,
        });
    }

    logger.debug("Metadata refresh range chunk processed", {
        component: "IndexerDomainWorker",
        action: "handleMetadataRefreshRange",
        chainId: payload.chainId,
        contract,
        fromTokenId: payload.fromTokenId,
        toTokenId: payload.toTokenId,
        cursorTokenId: payload.cursorTokenId,
        processed: tokenIds.length,
        nextCursorTokenId,
    });

    if (!nextCursorTokenId) {
        return;
    }

    const nextPayload: MetadataRefreshRangePayload = {
        ...payload,
        contract,
        cursorTokenId: nextCursorTokenId,
    };
    const nextJob: JobEnvelope<MetadataRefreshRangePayload> = {
        jobId: `metadata:refresh-range:${payload.chainId}:${contract}:${payload.fromTokenId}:${payload.toTokenId}:${nextCursorTokenId}`,
        kind: DOMAIN_JOB_KIND.MetadataRefreshRange,
        queue: QUEUE_NAMES.MetadataRefresh,
        payload: nextPayload,
        attempt: 0,
        scheduledAt: Date.now(),
        chainId: payload.chainId,
        traceId,
    };
    await queue.publish(QUEUE_NAMES.MetadataRefresh, nextJob);
}

function chunkTokenIdRange(
    fromTokenId: string,
    toTokenId: string,
    cursorTokenId: string,
    chunkSize: number,
): {
    tokenIds: string[];
    nextCursorTokenId: string | null;
} {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
        throw new Error(`Invalid metadata refresh chunk size: ${chunkSize}`);
    }

    const from = BigInt(fromTokenId);
    const to = BigInt(toTokenId);
    const cursor = BigInt(cursorTokenId);
    if (from > to) {
        throw new Error(
            `Invalid metadata refresh range: fromTokenId (${fromTokenId}) > toTokenId (${toTokenId})`,
        );
    }
    if (cursor < from || cursor > to + 1n) {
        throw new Error(
            `Invalid metadata refresh cursor ${cursorTokenId} for range [${fromTokenId}, ${toTokenId}]`,
        );
    }
    if (cursor === to + 1n) {
        return {
            tokenIds: [],
            nextCursorTokenId: null,
        };
    }

    const chunkEnd = minBigInt(to, cursor + BigInt(chunkSize) - 1n);
    const tokenIds: string[] = [];
    for (let tokenId = cursor; tokenId <= chunkEnd; tokenId += 1n) {
        tokenIds.push(tokenId.toString());
    }
    const nextCursorTokenId =
        chunkEnd >= to ? null : (chunkEnd + 1n).toString();

    return {
        tokenIds,
        nextCursorTokenId,
    };
}

function minBigInt(a: bigint, b: bigint): bigint {
    return a < b ? a : b;
}

function toDomainContext(
    job: JobEnvelope<DomainSyncPayload>,
): DomainSyncContext {
    return {
        chainId: job.chainId,
        fromBlock: job.payload.fromBlock,
        toBlock: job.payload.toBlock,
        mode: job.payload.mode,
        sourceJobId: job.payload.sourceJobId,
        sourceKind: job.payload.sourceKind,
    };
}
