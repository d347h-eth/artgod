import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import {
    isImageCachePolicyActive,
    shouldRefreshImageCacheOnMetadata,
    type ImageCachePolicyConfig,
} from "@artgod/shared/media/token-image-cache";
import {
    TOKEN_IMAGE_CACHE_JOB_KIND,
    TOKEN_IMAGE_CACHE_REFRESH_REASON,
    buildTokenImageCacheRefreshCollectionJobId,
    buildTokenImageCacheRefreshTokenJobId,
    type TokenImageCacheRefreshCollectionPayload,
    type TokenImageCacheRefreshTokenPayload,
} from "@artgod/shared/media/token-image-cache-jobs";
import { loadConfig } from "../config/index.js";
import { SqliteCollectionExtensions } from "../infra/collection-extensions/sqlite.js";
import { runWorker } from "../application/worker-runner.js";
import { enqueueMetadataRefreshFollowups } from "../application/metadata/refresh-followups.js";
import { startQueueOutboxDrainer } from "../application/queue-outbox/drainer.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import {
    ACTIVITY_JOB_KIND,
    type ActivityUpsertPayload,
} from "../domain/activity-jobs.js";
import {
    DOMAIN_JOB_KIND,
    METADATA_REFRESH_SOURCE,
    METADATA_STATS_RECOMPUTE_REASON,
    type DomainSyncPayload,
    type MetadataRefreshPayload,
    type MetadataRefreshRangePayload,
    type MetadataStatsRecomputePayload,
} from "../domain/domain-jobs.js";
import { METADATA_REFRESH_RUN_ID_SCOPE } from "../domain/metadata-refresh-followups.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { SqliteOrdersDomain } from "../infra/domain/orders.js";
import type { DomainSyncContext } from "../ports/domain-handlers.js";
import { SqliteMetadataDomain } from "../infra/domain/metadata.js";
import { SqliteMetadataStatsDomain } from "../infra/domain/metadata-stats.js";
import { SqliteMetadataRefreshFollowups } from "../infra/metadata/sqlite-refresh-followups.js";
import { HttpMetadataFetcher } from "../infra/metadata/http-fetcher.js";
import { SharpTokenImageCache } from "../infra/media/sharp-token-image-cache.js";
import { SqliteImageCachePolicyResolver } from "../infra/media/sqlite-image-cache-policy.js";
import { SqliteTokenImageCacheRecords } from "../infra/media/sqlite-token-image-cache-records.js";
import { ViemTokenUriResolver } from "../infra/metadata/viem-token-uri.js";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import { SqliteActivityDomain } from "../infra/domain/activities.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import {
    INDEXER_RPC_ENDPOINT_ID_PREFIX,
    INDEXER_RPC_OBSERVABILITY_COMPONENT,
} from "../infra/rpc/observability.js";
import { SqliteConduitRegistry } from "../infra/conduits/sqlite.js";
import { validateSeaportOrder } from "../application/offchain/seaport-validate.js";
import type { MetadataUpdatedToken } from "../domain/metadata.js";
import type { CollectionExtensionInstallPort } from "../ports/collection-extensions.js";
import type { QueuePort } from "../ports/queue.js";
import type { TokenImageCachePort } from "../ports/token-image-cache.js";
import {
    ORDER_JOB_KIND,
    type OrderUpdateByIdPayload,
    type OrderUpdateByMakerPayload,
    type OrderUpsertPayload,
} from "../domain/order-jobs.js";
import { initRuntimeApm } from "@artgod/shared/observability/apm";
import { SqliteQueueOutbox } from "../infra/queue/sqlite-queue-outbox.js";

const ORDER_UPDATE_BY_MAKER_LEASE_EXTENSION_MS = 10_000;

async function main() {
    try {
        const config = loadConfig();
        setDbPath(config.dbPath);
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "domain-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.domainWorker,
            worker: "domain-worker",
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
            component: INDEXER_RPC_OBSERVABILITY_COMPONENT.DomainHttp,
            endpointIdPrefix: INDEXER_RPC_ENDPOINT_ID_PREFIX.DomainHttp,
            retryPolicy: config.rpc.retryPolicy,
            resilience: config.rpc.resilience,
        });
        const conduits = new SqliteConduitRegistry();
        const validateOrder = (
            order: Parameters<typeof validateSeaportOrder>[3],
        ) => validateSeaportOrder(rpc, conduits, config.seaport, order);
        const ordersDomain = new SqliteOrdersDomain(
            config.tokens.wethAddress,
            validateOrder,
            config.debugPayloads,
        );
        const metadataResolver = new ViemTokenUriResolver({
            endpoints: config.rpc.endpoints,
            metrics: runtimeMetrics.metrics,
            component: INDEXER_RPC_OBSERVABILITY_COMPONENT.Metadata,
            endpointIdPrefix: INDEXER_RPC_ENDPOINT_ID_PREFIX.Metadata,
            retryPolicy: config.rpc.retryPolicy,
            resilience: config.rpc.resilience,
        });
        const metadataFetcher = new HttpMetadataFetcher({
            fetchResilience: config.httpFetch,
            metrics: runtimeMetrics.metrics,
        });
        const metadataDomain = new SqliteMetadataDomain(
            metadataResolver,
            metadataFetcher,
            config.debugPayloads,
        );
        const metadataStatsDomain = new SqliteMetadataStatsDomain();
        const activityDomain = new SqliteActivityDomain();
        const collectionExtensions = new SqliteCollectionExtensions(
            config.debugPayloads,
        );
        const queueOutbox = new SqliteQueueOutbox();
        const metadataRefreshFollowups = new SqliteMetadataRefreshFollowups(
            queueOutbox,
        );
        const stopQueueOutboxDrainer = startQueueOutboxDrainer(
            queueOutbox,
            queue,
        );
        const imageCachePolicyResolver = new SqliteImageCachePolicyResolver(
            collectionExtensions,
        );
        const tokenImageCacheRecords = new SqliteTokenImageCacheRecords();
        const tokenImageCache = new SharpTokenImageCache({
            rootDir: config.mediaCache.tokenImagesDir,
            ipfsGatewayOrigin: config.ipfs.gatewayOrigin,
            maxSourceBytes: config.bootstrap.imageCacheMaxSourceBytes,
            fetchResilience: config.httpFetch,
        });
        const orderUpdateByMakerConsumerName = `orders-update-by-maker-${config.chainId}`;

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
            {
                apm: runtimeApm.apm,
                spanName: "worker.ordersDomain.consume",
            },
        );

        const stopOrderUpdatesByMaker = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.OrdersUpdateByMaker,
                consumerName: orderUpdateByMakerConsumerName,
                maxInFlight: 1,
                extendLeaseMs: ORDER_UPDATE_BY_MAKER_LEASE_EXTENSION_MS,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<OrderUpdateByMakerPayload>) => {
                if (job.kind !== ORDER_JOB_KIND.UpdateByMaker) return;
                await ordersDomain.handleOrderUpdateByMaker(job.payload, {
                    jobId: job.jobId,
                    attempt: job.attempt ?? 0,
                    scheduledAt: job.scheduledAt,
                    traceId: job.traceId ?? null,
                    consumerName: orderUpdateByMakerConsumerName,
                });
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.ordersUpdateByMaker.consume",
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
            {
                apm: runtimeApm.apm,
                spanName: "worker.ordersUpdateById.consume",
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
            {
                apm: runtimeApm.apm,
                spanName: "worker.ordersUpsert.consume",
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
                const result = await metadataDomain.handleDomainSync(
                    toDomainContext(job),
                );
                const statsReason = deriveMetadataStatsReason(
                    job.payload.sourceJobId,
                );
                enqueueMetadataRefreshFollowups({
                    followups: metadataRefreshFollowups,
                    collectionExtensions,
                    chainId: job.chainId,
                    updatedTokens: result.updatedTokens,
                    runScope: METADATA_REFRESH_RUN_ID_SCOPE.MetadataSync,
                    artifactReason: statsReason,
                    statsReason,
                    sourceJobId: job.jobId,
                    traceId: job.traceId ?? job.jobId,
                    source: METADATA_REFRESH_SOURCE.Onchain,
                });
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.metadataDomain.consume",
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
                    const payload = job.payload as MetadataRefreshPayload;
                    const updated =
                        await metadataDomain.handleMetadataRefresh(payload);
                    if (updated) {
                        enqueueMetadataRefreshFollowups({
                            followups: metadataRefreshFollowups,
                            collectionExtensions,
                            chainId: job.chainId,
                            updatedTokens: [updated],
                            runScope:
                                METADATA_REFRESH_RUN_ID_SCOPE.MetadataRefresh,
                            artifactReason: payload.reason,
                            statsReason:
                                METADATA_STATS_RECOMPUTE_REASON.MetadataRefresh,
                            sourceJobId: job.jobId,
                            traceId: job.traceId ?? job.jobId,
                            source: payload.source,
                        });
                        await publishTokenImageCacheRefreshJobs(
                            queue,
                            imageCachePolicyResolver,
                            job.chainId,
                            [updated],
                            job.traceId ?? job.jobId,
                            payload.source,
                        );
                    }
                    return;
                }
                if (job.kind === DOMAIN_JOB_KIND.MetadataRefreshRange) {
                    await handleMetadataRefreshRangeJob(
                        queue,
                        metadataDomain,
                        metadataRefreshFollowups,
                        collectionExtensions,
                        imageCachePolicyResolver,
                        job.payload as MetadataRefreshRangePayload,
                        config.metadata.refreshRangeChunkSize,
                        job.traceId ?? job.jobId,
                        job.jobId,
                    );
                }
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.metadataRefresh.consume",
            },
        );

        const stopMetadataStats = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.MetadataStats,
                consumerName: `metadata-stats-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<MetadataStatsRecomputePayload>) => {
                if (job.kind !== DOMAIN_JOB_KIND.MetadataStatsRecompute) return;
                await metadataStatsDomain.handleRecompute(job.payload);
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.metadataStats.consume",
            },
        );

        const stopTokenImageCache = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.TokenImageCache,
                consumerName: `token-image-cache-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (
                job: JobEnvelope<
                    | TokenImageCacheRefreshTokenPayload
                    | TokenImageCacheRefreshCollectionPayload
                >,
            ) => {
                if (job.kind === TOKEN_IMAGE_CACHE_JOB_KIND.RefreshToken) {
                    await handleTokenImageCacheRefreshJob(
                        tokenImageCacheRecords,
                        tokenImageCache,
                        imageCachePolicyResolver,
                        job.payload as TokenImageCacheRefreshTokenPayload,
                    );
                    return;
                }
                if (job.kind === TOKEN_IMAGE_CACHE_JOB_KIND.RefreshCollection) {
                    await handleCollectionImageCacheRefreshJob(
                        queue,
                        tokenImageCacheRecords,
                        tokenImageCache,
                        imageCachePolicyResolver,
                        job.payload as TokenImageCacheRefreshCollectionPayload,
                        config.bootstrap.imageCacheBatchSize,
                        config.bootstrap.imageCacheConcurrency,
                        job.traceId ?? job.jobId,
                    );
                }
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.tokenImageCache.consume",
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
            {
                apm: runtimeApm.apm,
                spanName: "worker.activityDomain.consume",
            },
        );
        const stopActivityUpsert = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.ActivityUpsert,
                consumerName: `activity-upsert-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<ActivityUpsertPayload>) => {
                if (job.kind !== ACTIVITY_JOB_KIND.Upsert) return;
                await activityDomain.handleActivityUpsert(job.payload);
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.activityUpsert.consume",
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
            await stopMetadataStats();
            await stopTokenImageCache();
            await stopActivity();
            await stopActivityUpsert();
            await stopQueueOutboxDrainer();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
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

function deriveMetadataStatsReason(
    sourceJobId: string,
): MetadataStatsRecomputePayload["reason"] {
    if (sourceJobId.startsWith("sync:reorg:")) {
        return METADATA_STATS_RECOMPUTE_REASON.ReorgResync;
    }
    return METADATA_STATS_RECOMPUTE_REASON.MetadataSync;
}

async function handleMetadataRefreshRangeJob(
    queue: QueuePort,
    metadataDomain: SqliteMetadataDomain,
    metadataRefreshFollowups: SqliteMetadataRefreshFollowups,
    collectionExtensions: CollectionExtensionInstallPort,
    imageCachePolicyResolver: SqliteImageCachePolicyResolver,
    payload: MetadataRefreshRangePayload,
    chunkSize: number,
    traceId: string,
    sourceJobId: string,
): Promise<void> {
    const { tokenIds, nextCursorTokenId } = chunkTokenIdRange(
        payload.fromTokenId,
        payload.toTokenId,
        payload.cursorTokenId,
        chunkSize,
    );

    const updatedTokens: MetadataUpdatedToken[] = [];
    for (const tokenId of tokenIds) {
        const updated = await metadataDomain.handleMetadataRefresh({
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            tokenId,
            metadataUrl: null,
            reason: payload.reason,
            source: payload.source,
        });
        if (updated) {
            updatedTokens.push(updated);
        }
    }
    if (updatedTokens.length > 0) {
        enqueueMetadataRefreshFollowups({
            followups: metadataRefreshFollowups,
            collectionExtensions,
            chainId: payload.chainId,
            updatedTokens,
            runScope: METADATA_REFRESH_RUN_ID_SCOPE.MetadataRefreshRange,
            artifactReason: payload.reason,
            statsReason: METADATA_STATS_RECOMPUTE_REASON.MetadataRefresh,
            sourceJobId,
            traceId,
            source: payload.source,
        });
        await publishTokenImageCacheRefreshJobs(
            queue,
            imageCachePolicyResolver,
            payload.chainId,
            updatedTokens,
            traceId,
            payload.source,
        );
    }

    logger.debug("Metadata refresh range chunk processed", {
        component: "IndexerDomainWorker",
        action: "handleMetadataRefreshRange",
        chainId: payload.chainId,
        collectionId: payload.collectionId,
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
        cursorTokenId: nextCursorTokenId,
    };
    const nextJob: JobEnvelope<MetadataRefreshRangePayload> = {
        jobId: `metadata:refresh-range:${payload.chainId}:${payload.collectionId}:${payload.fromTokenId}:${payload.toTokenId}:${nextCursorTokenId}`,
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
        collectionId: job.collectionId ?? null,
        fromBlock: job.payload.fromBlock,
        toBlock: job.payload.toBlock,
        mode: job.payload.mode,
        projection: job.payload.projection,
        sourceJobId: job.payload.sourceJobId,
        sourceKind: job.payload.sourceKind,
    };
}

async function publishTokenImageCacheRefreshJobs(
    queue: QueuePort,
    imageCachePolicyResolver: SqliteImageCachePolicyResolver,
    chainId: number,
    updatedTokens: MetadataUpdatedToken[],
    traceId: string,
    source?: string | null,
): Promise<void> {
    const policyByCollectionId = new Map<number, ImageCachePolicyConfig>();

    for (const updated of updatedTokens) {
        const sourceImageUrl = updated.image?.trim() ?? "";
        if (!sourceImageUrl) {
            continue;
        }
        let policy = policyByCollectionId.get(updated.collectionId);
        if (!policy) {
            policy = imageCachePolicyResolver.getImageCachePolicyConfig({
                chainId,
                collectionId: updated.collectionId,
            });
            policyByCollectionId.set(updated.collectionId, policy);
        }
        if (!shouldRefreshImageCacheOnMetadata(policy)) {
            continue;
        }

        const payload: TokenImageCacheRefreshTokenPayload = {
            chainId,
            collectionId: updated.collectionId,
            tokenId: updated.tokenId,
            sourceImageUrl,
            requestedMaxDimension: policy.maxDimension,
            imageCacheMode: policy.imageCacheMode,
            reason: TOKEN_IMAGE_CACHE_REFRESH_REASON.MetadataRefresh,
            source: source ?? null,
        };
        const job: JobEnvelope<TokenImageCacheRefreshTokenPayload> = {
            jobId: buildTokenImageCacheRefreshTokenJobId(payload),
            kind: TOKEN_IMAGE_CACHE_JOB_KIND.RefreshToken,
            queue: QUEUE_NAMES.TokenImageCache,
            payload,
            attempt: 0,
            scheduledAt: Date.now(),
            chainId,
            collectionId: updated.collectionId,
            traceId,
        };
        await queue.publish(QUEUE_NAMES.TokenImageCache, job);
    }
}

async function handleTokenImageCacheRefreshJob(
    records: SqliteTokenImageCacheRecords,
    tokenImageCache: TokenImageCachePort,
    imageCachePolicyResolver: SqliteImageCachePolicyResolver,
    payload: TokenImageCacheRefreshTokenPayload,
): Promise<void> {
    const policy = imageCachePolicyResolver.getImageCachePolicyConfig(payload);
    if (!shouldProcessImageCachePayload(policy, payload)) {
        return;
    }
    const currentSource = records.getTokenImageSource(payload);
    if (currentSource?.sourceImageUrl !== payload.sourceImageUrl) {
        return;
    }

    const result = await tokenImageCache.cacheTokenImage({
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        tokenId: payload.tokenId,
        sourceImageUrl: payload.sourceImageUrl,
        requestedMaxDimension: payload.requestedMaxDimension,
    });
    const stored = records.upsertTokenImageCache({
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        tokenId: payload.tokenId,
        sourceImageUrl: payload.sourceImageUrl,
        requestedMaxDimension: payload.requestedMaxDimension,
        ...result,
    });
    if (!stored) {
        await tokenImageCache.deleteCachedTokenImage(result.relativePath);
    }
}

async function handleCollectionImageCacheRefreshJob(
    queue: QueuePort,
    records: SqliteTokenImageCacheRecords,
    tokenImageCache: TokenImageCachePort,
    imageCachePolicyResolver: SqliteImageCachePolicyResolver,
    payload: TokenImageCacheRefreshCollectionPayload,
    batchSize: number,
    concurrency: number,
    traceId: string,
): Promise<void> {
    const policy = imageCachePolicyResolver.getImageCachePolicyConfig(payload);
    if (!shouldProcessImageCachePayload(policy, payload)) {
        return;
    }

    const limit = Math.max(1, batchSize);
    const sources = records.listCollectionImageSources({
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        cursorTokenId: payload.cursorTokenId,
        limit,
    });
    await mapWithConcurrency(
        sources,
        Math.max(1, concurrency),
        async (source) => {
            try {
                const result = await tokenImageCache.cacheTokenImage({
                    chainId: payload.chainId,
                    collectionId: payload.collectionId,
                    tokenId: source.tokenId,
                    sourceImageUrl: source.sourceImageUrl,
                    requestedMaxDimension: payload.requestedMaxDimension,
                });
                const stored = records.upsertTokenImageCache({
                    chainId: payload.chainId,
                    collectionId: payload.collectionId,
                    tokenId: source.tokenId,
                    sourceImageUrl: source.sourceImageUrl,
                    requestedMaxDimension: payload.requestedMaxDimension,
                    ...result,
                });
                if (!stored) {
                    await tokenImageCache.deleteCachedTokenImage(
                        result.relativePath,
                    );
                }
            } catch (error) {
                logger.warn("Token image cache refresh failed", {
                    component: "IndexerDomainWorker",
                    action: "handleCollectionImageCacheRefreshJob",
                    chainId: payload.chainId,
                    collectionId: payload.collectionId,
                    tokenId: source.tokenId,
                    error: String(error),
                });
            }
        },
    );

    if (sources.length < limit) {
        return;
    }
    const nextCursorTokenId = sources[sources.length - 1]?.tokenId ?? null;
    if (!nextCursorTokenId) {
        return;
    }

    const nextPayload: TokenImageCacheRefreshCollectionPayload = {
        ...payload,
        cursorTokenId: nextCursorTokenId,
    };
    const nextJob: JobEnvelope<TokenImageCacheRefreshCollectionPayload> = {
        jobId: buildTokenImageCacheRefreshCollectionJobId(nextPayload),
        kind: TOKEN_IMAGE_CACHE_JOB_KIND.RefreshCollection,
        queue: QUEUE_NAMES.TokenImageCache,
        payload: nextPayload,
        attempt: 0,
        scheduledAt: Date.now(),
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        traceId,
    };
    await queue.publish(QUEUE_NAMES.TokenImageCache, nextJob);
}

function shouldProcessImageCachePayload(
    policy: ImageCachePolicyConfig,
    payload: {
        imageCacheMode: ImageCachePolicyConfig["imageCacheMode"];
        requestedMaxDimension: number | null;
    },
): boolean {
    return (
        isImageCachePolicyActive(policy) &&
        policy.imageCacheMode === payload.imageCacheMode &&
        policy.maxDimension === payload.requestedMaxDimension
    );
}

async function mapWithConcurrency<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
): Promise<void> {
    const limit = Math.max(1, concurrency);
    let nextIndex = 0;
    const workers = Array.from(
        { length: Math.min(limit, items.length) },
        async () => {
            while (nextIndex < items.length) {
                const item = items[nextIndex];
                nextIndex += 1;
                if (item !== undefined) {
                    await fn(item);
                }
            }
        },
    );
    await Promise.all(workers);
}
