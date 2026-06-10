import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import { resolveEmbeddedCollectionExtensionInstallByKey } from "@artgod/shared/extensions/built-ins";
import {
    BOOTSTRAP_RUN_EVENT_CODE,
    serializeBootstrapEnumerationProgressEventPayload,
} from "@artgod/shared/bootstrap/run-events";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    type BootstrapStepKey,
} from "@artgod/shared/bootstrap/pipeline";
import {
    isImageCachePolicyActive,
    type ImageCacheMode,
} from "@artgod/shared/media/token-image-cache";
import { ERC721_ENUMERABLE_ABI } from "../abi/index.js";
import { publishCollectionExtensionRefreshArtifacts } from "../application/collection-extensions/jobs.js";
import { runWorker } from "../application/worker-runner.js";
import { publishMetadataStatsRecompute } from "../application/metadata/stats-recompute.js";
import { loadConfig } from "../config/index.js";
import type {
    BootstrapImageCacheProcessPayload,
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
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
    SYNC_JOB_KIND,
    type BackfillSyncPayload,
} from "../domain/sync-jobs.js";
import {
    OPENSEA_JOB_KIND,
    type OpenSeaBootstrapCollectionPayload,
} from "../domain/opensea-jobs.js";
import { SqliteBootstrapStorage } from "../infra/bootstrap/sqlite.js";
import { SqliteBootstrapRuns } from "../infra/bootstrap/sqlite-runs.js";
import { SqliteBootstrapSteps } from "../infra/bootstrap/sqlite-steps.js";
import { SqliteCollectionExtensions } from "../infra/collection-extensions/sqlite.js";
import { SqliteCollectionRegistry } from "../infra/collections/sqlite.js";
import { SqliteMetadataDomain } from "../infra/domain/metadata.js";
import { HttpMetadataFetcher } from "../infra/metadata/http-fetcher.js";
import { SharpTokenImageCache } from "../infra/media/sharp-token-image-cache.js";
import { ViemTokenUriResolver } from "../infra/metadata/viem-token-uri.js";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import type {
    BootstrapMetadataTask,
    BootstrapMetadataTaskSeed,
    BootstrapSnapshotPort,
    BootstrapImageCacheTask,
} from "../ports/bootstrap.js";
import type { BootstrapRunsPort } from "../ports/bootstrap-runs.js";
import type { BootstrapStepsPort } from "../ports/bootstrap-steps.js";
import type { CollectionRegistryPort } from "../ports/collections.js";
import type { CollectionExtensionInstallPort } from "../ports/collection-extensions.js";
import type { MetadataRefreshPayload } from "../domain/domain-jobs.js";
import type { TokenImageCachePort } from "../ports/token-image-cache.js";
import type { QueuePort } from "../ports/queue.js";
import type { Hex, RpcProviderPort } from "../ports/rpc.js";
import type { StoragePort } from "../ports/storage.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import {
    INDEXER_RPC_ENDPOINT_ID_PREFIX,
    INDEXER_RPC_OBSERVABILITY_COMPONENT,
} from "../infra/rpc/observability.js";
import { SqliteStorage } from "../infra/storage/sqlite.js";
import { initRuntimeApm } from "@artgod/shared/observability/apm";

const BOOTSTRAP_BACKFILL_CHECK_DELAY_MS = 5_000;
const TOKEN_ENUMERATION_HEARTBEAT_MS = 15_000;
const TOKEN_ENUMERATION_PROGRESS_STEP = 1_000;
const METADATA_TASK_SEED_PROGRESS_STEP = 10_000;

async function main() {
    try {
        const config = loadConfig();
        setDbPath(config.dbPath);
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "bootstrap-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
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
            endpoints: config.rpc.endpoints,
            logChunkSize: config.sync.logChunkSize,
            metrics: runtimeMetrics.metrics,
            component: INDEXER_RPC_OBSERVABILITY_COMPONENT.BootstrapHttp,
            endpointIdPrefix: INDEXER_RPC_ENDPOINT_ID_PREFIX.BootstrapHttp,
            retryPolicy: config.rpc.retryPolicy,
            resilience: config.rpc.resilience,
        });
        const collections = new SqliteCollectionRegistry();
        const collectionExtensions = new SqliteCollectionExtensions();
        const bootstrapStorage = new SqliteBootstrapStorage();
        const bootstrapRuns = new SqliteBootstrapRuns();
        const bootstrapSteps = new SqliteBootstrapSteps();
        const storage = new SqliteStorage();
        const metadataResolver = new ViemTokenUriResolver({
            endpoints: config.rpc.endpoints,
            metrics: runtimeMetrics.metrics,
            component: INDEXER_RPC_OBSERVABILITY_COMPONENT.Metadata,
            endpointIdPrefix: INDEXER_RPC_ENDPOINT_ID_PREFIX.Metadata,
            retryPolicy: config.rpc.retryPolicy,
            resilience: config.rpc.resilience,
        });
        const metadataFetcher = new HttpMetadataFetcher({
            ipfsGateway: config.ipfs.gatewayOrigin,
            fetchResilience: config.httpFetch,
            metrics: runtimeMetrics.metrics,
        });
        const metadataDomain = new SqliteMetadataDomain(
            metadataResolver,
            metadataFetcher,
        );
        const tokenImageCache = new SharpTokenImageCache({
            rootDir: config.mediaCache.tokenImagesDir,
            ipfsGatewayOrigin: config.ipfs.gatewayOrigin,
            maxSourceBytes: config.bootstrap.imageCacheMaxSourceBytes,
            fetchResilience: config.httpFetch,
        });

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
                    | BootstrapImageCacheProcessPayload
                    | BootstrapBackfillCheckPayload
                >,
            ) => {
                try {
                    if (job.kind === BOOTSTRAP_JOB_KIND.Start) {
                        await handleBootstrapStart(
                            rpc,
                            queue,
                            collections,
                            collectionExtensions,
                            bootstrapStorage,
                            bootstrapRuns,
                            bootstrapSteps,
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
                            collectionExtensions,
                            bootstrapStorage,
                            bootstrapRuns,
                            bootstrapSteps,
                            metadataDomain,
                            config.sync.backfillBatchSize,
                            config.bootstrap.snapshotBatchSize,
                            config.bootstrap.metadataBatchSize,
                            config.bootstrap.metadataConcurrency,
                            config.bootstrap.metadataProcessPollMs,
                            config.bootstrap.metadataRetryPolicy,
                            config.integrations.opensea,
                            job.payload as BootstrapMetadataProcessPayload,
                            job.traceId ?? job.jobId,
                            job.jobId,
                        );
                        return;
                    }

                    if (job.kind === BOOTSTRAP_JOB_KIND.ImageCacheProcess) {
                        await handleBootstrapImageCacheProcess(
                            rpc,
                            queue,
                            collections,
                            bootstrapStorage,
                            bootstrapRuns,
                            bootstrapSteps,
                            tokenImageCache,
                            config.sync.backfillBatchSize,
                            config.bootstrap.snapshotBatchSize,
                            config.bootstrap.imageCacheBatchSize,
                            config.bootstrap.imageCacheConcurrency,
                            config.bootstrap.metadataRetryPolicy,
                            config.integrations.opensea,
                            job.payload as BootstrapImageCacheProcessPayload,
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
                            bootstrapRuns,
                            bootstrapSteps,
                            job.payload as BootstrapBackfillCheckPayload,
                            job.traceId ?? job.jobId,
                            job.jobId,
                        );
                    }
                } catch (error) {
                    const runId = Number(
                        (job.payload as { runId?: unknown }).runId,
                    );
                    if (Number.isInteger(runId) && job.attempt >= 5) {
                        bootstrapRuns.updateRunStatus(
                            runId,
                            BOOTSTRAP_RUN_STATUS.Failed,
                            {
                                code: "max_attempts_exceeded",
                                message: String(error),
                            },
                        );
                        const run = bootstrapRuns.getRun(runId);
                        if (run) {
                            bootstrapRuns.appendRunEvent({
                                runId,
                                chainId: run.chainId,
                                collectionId: run.collectionId,
                                eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunFailed,
                                eventLevel: "error",
                                message:
                                    "Bootstrap run failed after max retry attempts",
                                payloadJson: JSON.stringify({
                                    error: String(error),
                                    sourceJobId: job.jobId,
                                }),
                            });
                        }
                    }
                    throw error;
                }
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.bootstrap.consume",
            },
        );

        logger.info("Collection bootstrap worker ready", {
            component: "CollectionBootstrapWorker",
            action: "main",
            rpcEndpoint: summarizeRpcUrl(config.rpc.endpoints[0]?.url ?? ""),
            rpcRateLimitRps:
                config.rpc.resilience.rateLimiter.requestsPerSecond,
            rpcRateLimitBurst: config.rpc.resilience.rateLimiter.burst,
        });

        const shutdown = async () => {
            logger.info("Collection bootstrap worker shutting down", {
                component: "CollectionBootstrapWorker",
                action: "shutdown",
            });
            await stop();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
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

function summarizeRpcUrl(raw: string): string {
    try {
        const parsed = new URL(raw);
        return `${parsed.protocol}//${parsed.host}`;
    } catch {
        return "<invalid-rpc-url>";
    }
}

async function handleBootstrapStart(
    rpc: RpcProviderPort,
    queue: QueuePort,
    collections: CollectionRegistryPort,
    collectionExtensions: CollectionExtensionInstallPort,
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    reorgDepth: number,
    metadataBatchSize: number,
    payload: BootstrapCollectionPayload,
    traceId: string,
): Promise<void> {
    const run = bootstrapRuns.getRun(payload.runId);
    if (!run) {
        logger.warn("Bootstrap skipped (run missing)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return;
    }
    if (run.requestStandard !== "erc721") {
        logger.warn("Bootstrap skipped (unsupported standard)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            standard: run.requestStandard,
        });
        bootstrapRuns.updateRunStatus(
            run.runId,
            BOOTSTRAP_RUN_STATUS.Failed,
            {
                code: "unsupported_standard",
                message: `Unsupported standard: ${run.requestStandard}`,
            },
        );
        bootstrapRuns.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunFailed,
            eventLevel: "error",
            message: "Unsupported standard for bootstrap",
            payloadJson: JSON.stringify({ standard: run.requestStandard }),
        });
        return;
    }

    bootstrapSteps.markStepRunning(run.runId, BOOTSTRAP_STEP_KEY.Anchor);
    const anchorBlock = await resolveAnchorBlock(rpc, reorgDepth);
    if (anchorBlock === null) {
        logger.warn("Bootstrap skipped (invalid anchor block)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
        });
        bootstrapSteps.markStepFailedTerminal({
            runId: run.runId,
            stepKey: BOOTSTRAP_STEP_KEY.Anchor,
            attempts: 1,
            error: "Anchor block is invalid",
        });
        bootstrapRuns.updateRunStatus(
            run.runId,
            BOOTSTRAP_RUN_STATUS.Failed,
            {
                code: "invalid_anchor",
                message: "Anchor block is invalid",
            },
        );
        return;
    }

    const anchor = await rpc.getBlock(anchorBlock);
    bootstrapRuns.updateRunAnchor({
        runId: run.runId,
        anchorBlock,
        anchorHash: anchor.hash,
        anchorTimestamp: anchor.timestamp,
    });
    bootstrapRuns.updateRunStatus(run.runId, BOOTSTRAP_RUN_STATUS.Metadata);
    bootstrapSteps.markStepSucceeded(run.runId, BOOTSTRAP_STEP_KEY.Anchor);
    bootstrapRuns.appendRunEvent({
        runId: run.runId,
        chainId: run.chainId,
        collectionId: run.collectionId,
        eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunAnchorSelected,
        eventLevel: "info",
        message: "Bootstrap anchor selected",
        payloadJson: JSON.stringify({
            anchorBlock,
            anchorHash: anchor.hash,
            anchorTimestamp: anchor.timestamp,
        }),
    });

    const updated = collections.markBootstrapStarted(
        run.chainId,
        run.collectionId,
        anchorBlock,
    );
    if (!updated) {
        logger.warn("Bootstrap skipped (collection missing)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            anchorBlock,
        });
        bootstrapRuns.updateRunStatus(
            run.runId,
            BOOTSTRAP_RUN_STATUS.Failed,
            {
                code: "missing_collection",
                message: "Collection row is missing",
            },
        );
        return;
    }

    ensureRequestedCollectionExtensionInstalled(
        collectionExtensions,
        run.chainId,
        run.collectionId,
        run.requestExtensionKey,
    );

    let activeStartStep: BootstrapStepKey = BOOTSTRAP_STEP_KEY.Enumeration;
    try {
        bootstrapStorage.resetSnapshot(run.runId);
        bootstrapStorage.resetMetadataTasks(run.runId);
        bootstrapStorage.resetImageCacheTasks(run.runId);
        bootstrapStorage.resetOwnershipTasks(run.runId);
        bootstrapSteps.markStepRunning(
            run.runId,
            BOOTSTRAP_STEP_KEY.Enumeration,
        );

        logger.info("Bootstrap token enumeration starting", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            enumerationMode: run.enumerationMode,
            anchorBlock,
        });
        bootstrapRuns.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationStarted,
            eventLevel: "info",
            message: "Token enumeration started",
            payloadJson: JSON.stringify({
                enumerationMode: run.enumerationMode,
                anchorBlock,
            }),
        });

        const enumerationStartedAt = Date.now();
        let resolvedCount = 0;
        let totalCount: number | null = null;
        const heartbeat = setInterval(() => {
            logger.info("Bootstrap token enumeration in progress", {
                component: "CollectionBootstrapWorker",
                action: "handleBootstrapStart",
                runId: run.runId,
                chainId: run.chainId,
                collectionId: run.collectionId,
                enumerationMode: run.enumerationMode,
                resolvedTokenIds: resolvedCount,
                totalTokenIds: totalCount,
                elapsedMs: Date.now() - enumerationStartedAt,
            });
        }, TOKEN_ENUMERATION_HEARTBEAT_MS);

        let tokenIds: string[];
        try {
            tokenIds = await resolveTokenIdsForRun(
                rpc,
                run,
                anchorBlock,
                (progress) => {
                    resolvedCount = progress.resolved;
                    totalCount = progress.total;
                    bootstrapSteps.updateStepProgress(
                        run.runId,
                        BOOTSTRAP_STEP_KEY.Enumeration,
                        {
                            completed: progress.resolved,
                            total: progress.total,
                        },
                    );
                    if (
                        progress.resolved === progress.total ||
                        progress.resolved % TOKEN_ENUMERATION_PROGRESS_STEP ===
                            0
                    ) {
                        logger.info("Bootstrap token enumeration progress", {
                            component: "CollectionBootstrapWorker",
                            action: "handleBootstrapStart",
                            runId: run.runId,
                            chainId: run.chainId,
                            collectionId: run.collectionId,
                            enumerationMode: run.enumerationMode,
                            resolvedTokenIds: progress.resolved,
                            totalTokenIds: progress.total,
                            elapsedMs: Date.now() - enumerationStartedAt,
                        });
                        if (
                            progress.total !== null &&
                            progress.resolved > 0 &&
                            progress.resolved < progress.total
                        ) {
                            bootstrapRuns.appendRunEvent({
                                runId: run.runId,
                                chainId: run.chainId,
                                collectionId: run.collectionId,
                                eventCode:
                                    BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationProgress,
                                eventLevel: "info",
                                message: "Token enumeration progress",
                                payloadJson:
                                    serializeBootstrapEnumerationProgressEventPayload(
                                        {
                                            resolved: progress.resolved,
                                            total: progress.total,
                                        },
                                    ),
                            });
                        }
                    }
                },
            );
        } finally {
            clearInterval(heartbeat);
        }
        const enumerationElapsedMs = Date.now() - enumerationStartedAt;
        logger.info("Bootstrap token enumeration completed", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            enumerationMode: run.enumerationMode,
            tokenCount: tokenIds.length,
            elapsedMs: enumerationElapsedMs,
        });
        bootstrapRuns.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationCompleted,
            eventLevel: "info",
            message: "Token enumeration completed",
            payloadJson: JSON.stringify({
                enumerationMode: run.enumerationMode,
                tokenCount: tokenIds.length,
                elapsedMs: enumerationElapsedMs,
            }),
        });
        bootstrapSteps.markStepSucceeded(
            run.runId,
            BOOTSTRAP_STEP_KEY.Enumeration,
            {
                completed: tokenIds.length,
                total: tokenIds.length,
            },
        );
        activeStartStep = BOOTSTRAP_STEP_KEY.Metadata;
        bootstrapSteps.markStepRunning(run.runId, BOOTSTRAP_STEP_KEY.Metadata);

        const writeBatchSize = Math.max(1, metadataBatchSize);
        const normalizedContract = run.requestAddress.toLowerCase();
        logger.info("Bootstrap metadata task seeding started", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            tokenCount: tokenIds.length,
            writeBatchSize,
        });
        let seededCount = 0;
        // Intentionally split inserts into multiple transactions so large collections
        // do not create one huge SQLite write transaction during bootstrap start.
        for (
            let cursor = 0;
            cursor < tokenIds.length;
            cursor += writeBatchSize
        ) {
            const end = Math.min(tokenIds.length, cursor + writeBatchSize);
            const rows: BootstrapMetadataTaskSeed[] = [];
            for (let index = cursor; index < end; index += 1) {
                rows.push({
                    runId: run.runId,
                    chainId: run.chainId,
                    collectionId: run.collectionId,
                    contract: normalizedContract,
                    tokenId: tokenIds[index],
                    standard: "erc721",
                    anchorBlock,
                    anchorHash: anchor.hash,
                    anchorTimestamp: anchor.timestamp,
                });
            }
            bootstrapStorage.insertMetadataTasks(rows);
            seededCount += rows.length;
            bootstrapSteps.updateStepProgress(
                run.runId,
                BOOTSTRAP_STEP_KEY.Metadata,
                {
                    completed: 0,
                    total: tokenIds.length,
                },
            );
            if (
                seededCount === tokenIds.length ||
                seededCount % METADATA_TASK_SEED_PROGRESS_STEP === 0
            ) {
                logger.info("Bootstrap metadata task seeding progress", {
                    component: "CollectionBootstrapWorker",
                    action: "handleBootstrapStart",
                    runId: run.runId,
                    chainId: run.chainId,
                    collectionId: run.collectionId,
                    seededCount,
                    tokenCount: tokenIds.length,
                });
            }
        }
        bootstrapRuns.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.MetadataTasksSeeded,
            eventLevel: "info",
            message: "Metadata tasks seeded",
            payloadJson: JSON.stringify({
                tokenCount: tokenIds.length,
                writeBatchSize,
            }),
        });

        await scheduleMetadataProcess(
            queue,
            {
                chainId: run.chainId,
                runId: run.runId,
                collectionId: run.collectionId,
                address: run.requestAddress,
                standard: run.requestStandard,
                metadataSnapshotMode: run.metadataMode,
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
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            address: run.requestAddress,
            standard: run.requestStandard,
            anchorBlock,
            metadataMode: run.metadataMode,
            tokenCount: tokenIds.length,
        });
        bootstrapRuns.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.MetadataQueued,
            eventLevel: "info",
            message: "Bootstrap metadata phase queued",
            payloadJson: JSON.stringify({
                anchorBlock,
                metadataMode: run.metadataMode,
                tokenCount: tokenIds.length,
            }),
        });
    } catch (error) {
        const message = String(error);
        logger.error("Bootstrap start failed", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            address: run.requestAddress,
            standard: run.requestStandard,
            anchorBlock,
            error: message,
        });
        bootstrapSteps.markStepFailedTerminal({
            runId: run.runId,
            stepKey: activeStartStep,
            attempts: 1,
            error: message,
        });
        bootstrapRuns.updateRunStatus(
            run.runId,
            BOOTSTRAP_RUN_STATUS.Failed,
            {
                code: "bootstrap_start_failed",
                message,
            },
        );
        bootstrapRuns.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunFailed,
            eventLevel: "error",
            message: "Bootstrap start failed",
            payloadJson: JSON.stringify({ error: message }),
        });
        throw error;
    }
}

async function handleBootstrapMetadataProcess(
    rpc: RpcProviderPort,
    queue: QueuePort,
    collections: CollectionRegistryPort,
    collectionExtensions: CollectionExtensionInstallPort,
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    metadataDomain: SqliteMetadataDomain,
    backfillBatchSize: number,
    snapshotBatchSize: number,
    metadataBatchSize: number,
    metadataConcurrency: number,
    metadataPollMs: number,
    metadataRetryPolicy: RetryPolicy,
    openSeaIntegration: OpenSeaIntegrationStatus,
    payload: BootstrapMetadataProcessPayload,
    traceId: string,
    sourceJobId: string,
): Promise<void> {
    if (payload.standard !== "erc721") {
        logger.warn("Metadata process skipped (unsupported standard)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapMetadataProcess",
            runId: payload.runId,
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
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return;
    }

    if (collection.status === "live") {
        logger.debug("Metadata process skipped (collection already live)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapMetadataProcess",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return;
    }

    if (bootstrapSteps.isStepPaused(payload.runId, BOOTSTRAP_STEP_KEY.Metadata)) {
        logger.info("Metadata process paused", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapMetadataProcess",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return;
    }

    bootstrapSteps.markStepRunning(payload.runId, BOOTSTRAP_STEP_KEY.Metadata);
    const processed = await processDueMetadataTasks(
        bootstrapStorage,
        metadataDomain,
        collectionExtensions,
        queue,
        payload,
        metadataBatchSize,
        metadataConcurrency,
        metadataRetryPolicy,
        traceId,
    );

    const counts = bootstrapStorage.getMetadataTaskCounts(payload.runId);
    const metadataCompleted = counts.succeeded + counts.failedTerminal;
    bootstrapSteps.updateStepProgress(
        payload.runId,
        BOOTSTRAP_STEP_KEY.Metadata,
        {
            completed: metadataCompleted,
            total: counts.total,
        },
    );
    const complete = isMetadataSnapshotComplete(
        counts,
        payload.metadataSnapshotMode,
    );
    if (!complete) {
        const hasDueNow =
            bootstrapStorage.listMetadataTasksDueNow(
                payload.runId,
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
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            mode: payload.metadataSnapshotMode,
            processed,
            counts,
            nextDelayMs: hasDueNow ? 0 : Math.max(1, metadataPollMs),
        });
        return;
    }

    const run = bootstrapRuns.getRun(payload.runId);
    if (!run) {
        logger.warn("Image cache skipped (run missing)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapMetadataProcess",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return;
    }

    if (isRunImageCacheActive(run)) {
        const seeded = bootstrapStorage.seedImageCacheTasks({
            runId: run.runId,
            requestedMaxDimension: run.imageCacheMaxDimension,
        });
        const imageCacheCounts = bootstrapStorage.getImageCacheTaskCounts(
            run.runId,
        );
        if (imageCacheCounts.total > 0) {
            bootstrapSteps.markStepSucceeded(
                run.runId,
                BOOTSTRAP_STEP_KEY.Metadata,
                {
                    completed: counts.total,
                    total: counts.total,
                },
            );
            bootstrapSteps.markStepRunning(
                run.runId,
                BOOTSTRAP_STEP_KEY.ImageCache,
            );
            bootstrapSteps.updateStepProgress(
                run.runId,
                BOOTSTRAP_STEP_KEY.ImageCache,
                {
                    completed:
                        imageCacheCounts.succeeded +
                        imageCacheCounts.failedTerminal,
                    total: imageCacheCounts.total,
                },
            );
            bootstrapRuns.updateRunStatus(
                run.runId,
                BOOTSTRAP_RUN_STATUS.ImageCache,
            );
            bootstrapRuns.appendRunEvent({
                runId: run.runId,
                chainId: run.chainId,
                collectionId: run.collectionId,
                eventCode: BOOTSTRAP_RUN_EVENT_CODE.ImageCacheQueued,
                eventLevel: "info",
                message: "Bootstrap image cache phase queued",
                payloadJson: JSON.stringify({
                    seeded,
                    total: imageCacheCounts.total,
                    maxDimension: run.imageCacheMaxDimension,
                }),
            });
            await scheduleImageCacheProcess(
                queue,
                {
                    chainId: payload.chainId,
                    runId: payload.runId,
                    collectionId: payload.collectionId,
                    address: payload.address,
                    standard: payload.standard,
                    anchorBlock: payload.anchorBlock,
                    anchorHash: payload.anchorHash,
                    anchorTimestamp: payload.anchorTimestamp,
                },
                traceId,
                0,
            );
            return;
        }
        bootstrapRuns.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.ImageCacheSkipped,
            eventLevel: "info",
            message: "Bootstrap image cache skipped because no token images were available",
            payloadJson: null,
        });
        bootstrapSteps.markStepSkipped(
            run.runId,
            BOOTSTRAP_STEP_KEY.ImageCache,
            "no token images available",
        );
    }
    bootstrapSteps.markStepSucceeded(run.runId, BOOTSTRAP_STEP_KEY.Metadata, {
        completed: counts.total,
        total: counts.total,
    });

    await continueBootstrapAfterMediaCache(
        rpc,
        queue,
        collections,
        bootstrapStorage,
        bootstrapRuns,
        bootstrapSteps,
        backfillBatchSize,
        snapshotBatchSize,
        openSeaIntegration,
        payload,
        traceId,
        sourceJobId,
    );
}

function isRunImageCacheActive(run: {
    imageCacheMode: ImageCacheMode;
    imageCacheMaxDimension: number | null;
}): boolean {
    return isImageCachePolicyActive({
        imageCacheMode: run.imageCacheMode,
        maxDimension: run.imageCacheMaxDimension,
    });
}

async function processDueMetadataTasks(
    bootstrapStorage: BootstrapSnapshotPort,
    metadataDomain: SqliteMetadataDomain,
    collectionExtensions: CollectionExtensionInstallPort,
    queue: QueuePort,
    payload: BootstrapMetadataProcessPayload,
    metadataBatchSize: number,
    metadataConcurrency: number,
    metadataRetryPolicy: RetryPolicy,
    traceId: string,
): Promise<number> {
    const dueTasks = bootstrapStorage.listMetadataTasksDueNow(
        payload.runId,
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
                collectionExtensions,
                queue,
                payload,
                task,
                metadataRetryPolicy,
                traceId,
            );
        },
    );

    return dueTasks.length;
}

async function handleBootstrapImageCacheProcess(
    rpc: RpcProviderPort,
    queue: QueuePort,
    collections: CollectionRegistryPort,
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    tokenImageCache: TokenImageCachePort,
    backfillBatchSize: number,
    snapshotBatchSize: number,
    imageCacheBatchSize: number,
    imageCacheConcurrency: number,
    imageCacheRetryPolicy: RetryPolicy,
    openSeaIntegration: OpenSeaIntegrationStatus,
    payload: BootstrapImageCacheProcessPayload,
    traceId: string,
    sourceJobId: string,
): Promise<void> {
    const collection = collections.getCollection(
        payload.chainId,
        payload.collectionId,
    );
    if (!collection) {
        logger.warn("Image cache process skipped (collection missing)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapImageCacheProcess",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return;
    }

    if (collection.status === "live") {
        logger.debug("Image cache process skipped (collection already live)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapImageCacheProcess",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return;
    }

    if (
        bootstrapSteps.isStepPaused(payload.runId, BOOTSTRAP_STEP_KEY.ImageCache)
    ) {
        logger.info("Image cache process paused", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapImageCacheProcess",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return;
    }

    bootstrapSteps.markStepRunning(payload.runId, BOOTSTRAP_STEP_KEY.ImageCache);
    const processed = await processDueImageCacheTasks(
        bootstrapStorage,
        tokenImageCache,
        payload,
        imageCacheBatchSize,
        imageCacheConcurrency,
        imageCacheRetryPolicy,
    );

    const counts = bootstrapStorage.getImageCacheTaskCounts(payload.runId);
    bootstrapSteps.updateStepProgress(
        payload.runId,
        BOOTSTRAP_STEP_KEY.ImageCache,
        {
            completed: counts.succeeded + counts.failedTerminal,
            total: counts.total,
        },
    );
    if (counts.pending > 0 || counts.retry > 0) {
        const hasDueNow =
            bootstrapStorage.listImageCacheTasksDueNow(
                payload.runId,
                Date.now(),
                1,
            ).length > 0;
        await scheduleImageCacheProcess(
            queue,
            payload,
            traceId,
            hasDueNow ? 0 : 5_000,
        );

        logger.debug("Bootstrap image cache process progress", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapImageCacheProcess",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            processed,
            counts,
            nextDelayMs: hasDueNow ? 0 : 5_000,
        });
        return;
    }

    bootstrapRuns.appendRunEvent({
        runId: payload.runId,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        eventCode: BOOTSTRAP_RUN_EVENT_CODE.ImageCacheCompleted,
        eventLevel: counts.failedTerminal > 0 ? "warn" : "info",
        message:
            counts.failedTerminal > 0
                ? "Bootstrap image cache completed with failed images"
                : "Bootstrap image cache completed",
        payloadJson: JSON.stringify(counts),
    });
    bootstrapSteps.markStepSucceeded(
        payload.runId,
        BOOTSTRAP_STEP_KEY.ImageCache,
        {
            completed: counts.total,
            total: counts.total,
        },
    );

    await continueBootstrapAfterMediaCache(
        rpc,
        queue,
        collections,
        bootstrapStorage,
        bootstrapRuns,
        bootstrapSteps,
        backfillBatchSize,
        snapshotBatchSize,
        openSeaIntegration,
        payload,
        traceId,
        sourceJobId,
    );
}

async function processDueImageCacheTasks(
    bootstrapStorage: BootstrapSnapshotPort,
    tokenImageCache: TokenImageCachePort,
    payload: BootstrapImageCacheProcessPayload,
    imageCacheBatchSize: number,
    imageCacheConcurrency: number,
    retryPolicy: RetryPolicy,
): Promise<number> {
    const dueTasks = bootstrapStorage.listImageCacheTasksDueNow(
        payload.runId,
        Date.now(),
        Math.max(1, imageCacheBatchSize),
    );
    if (dueTasks.length === 0) {
        return 0;
    }

    await mapWithConcurrency(
        dueTasks,
        Math.max(1, imageCacheConcurrency),
        async (task) => {
            await processSingleImageCacheTask(
                bootstrapStorage,
                tokenImageCache,
                task,
                retryPolicy,
            );
        },
    );

    return dueTasks.length;
}

async function processSingleImageCacheTask(
    bootstrapStorage: BootstrapSnapshotPort,
    tokenImageCache: TokenImageCachePort,
    task: BootstrapImageCacheTask,
    retryPolicy: RetryPolicy,
): Promise<void> {
    const attempts = task.attempts + 1;
    try {
        const result = await tokenImageCache.cacheTokenImage({
            chainId: task.chainId,
            collectionId: task.collectionId,
            tokenId: task.tokenId,
            sourceImageUrl: task.sourceImageUrl,
            requestedMaxDimension: task.requestedMaxDimension,
        });
        bootstrapStorage.markImageCacheTaskSucceeded({
            runId: task.runId,
            tokenId: task.tokenId,
            attempts,
            cacheKey: result.cacheKey,
            contentType: result.contentType,
            sourceBytes: result.sourceBytes,
            cachedBytes: result.cachedBytes,
            width: result.width,
            height: result.height,
            relativePath: result.relativePath,
            publicPath: result.publicPath,
        });
    } catch (error) {
        markImageCacheTaskFailed(
            bootstrapStorage,
            task,
            attempts,
            retryPolicy,
            String(error),
        );
    }
}

async function processSingleMetadataTask(
    bootstrapStorage: BootstrapSnapshotPort,
    metadataDomain: SqliteMetadataDomain,
    collectionExtensions: CollectionExtensionInstallPort,
    queue: QueuePort,
    payload: BootstrapMetadataProcessPayload,
    task: BootstrapMetadataTask,
    metadataRetryPolicy: RetryPolicy,
    traceId: string,
): Promise<void> {
    const attempts = task.attempts + 1;
    try {
        const refreshPayload: MetadataRefreshPayload = {
            chainId: payload.chainId,
            collectionId: payload.collectionId,
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
                task.runId,
                task.tokenId,
                attempts,
            );
            const install = collectionExtensions.getInstall(
                payload.chainId,
                payload.collectionId,
            );
            if (install?.enabled) {
                await publishCollectionExtensionRefreshArtifacts(
                    queue,
                    {
                        chainId: payload.chainId,
                        collectionId: payload.collectionId,
                        contract: updated.contract,
                        tokenId: updated.tokenId,
                        reason: refreshPayload.reason,
                        source: refreshPayload.source,
                    },
                    traceId,
                );
            }
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

function ensureRequestedCollectionExtensionInstalled(
    collectionExtensions: CollectionExtensionInstallPort,
    chainId: number,
    collectionId: number,
    extensionKey: CollectionExtensionKey | null,
): void {
    if (!extensionKey) {
        return;
    }

    const embedded = resolveEmbeddedCollectionExtensionInstallByKey({
        chainId,
        extensionKey,
    });
    if (!embedded) {
        throw new Error(
            `Embedded collection extension config missing for ${chainId}:${extensionKey}`,
        );
    }
    collectionExtensions.upsertInstall({
        chainId,
        collectionId,
        extensionKey,
        enabled: true,
        configJson: embedded.configJson,
    });
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
        task.runId,
        task.tokenId,
        attempts,
        nextAttemptAt,
        error,
        failedTerminal,
    );
}

function markImageCacheTaskFailed(
    bootstrapStorage: BootstrapSnapshotPort,
    task: BootstrapImageCacheTask,
    attempts: number,
    retryPolicy: RetryPolicy,
    error: string,
): void {
    const failedTerminal = attempts >= Math.max(1, retryPolicy.maxAttempts);
    const retryDelay = getRetryDelayMs(attempts, retryPolicy);
    bootstrapStorage.markImageCacheTaskRetry({
        runId: task.runId,
        tokenId: task.tokenId,
        attempts,
        nextAttemptAt: failedTerminal ? 0 : Date.now() + retryDelay,
        lastError: error,
        failedTerminal,
    });
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

async function continueBootstrapAfterMediaCache(
    rpc: RpcProviderPort,
    queue: QueuePort,
    collections: CollectionRegistryPort,
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    backfillBatchSize: number,
    snapshotBatchSize: number,
    openSeaIntegration: OpenSeaIntegrationStatus,
    payload: BootstrapImageCacheProcessPayload | BootstrapMetadataProcessPayload,
    traceId: string,
    sourceJobId: string,
): Promise<void> {
    const collection = collections.getCollection(
        payload.chainId,
        payload.collectionId,
    );
    if (!collection) {
        logger.warn("Bootstrap continuation skipped (collection missing)", {
            component: "CollectionBootstrapWorker",
            action: "continueBootstrapAfterMediaCache",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return;
    }

    // Metadata and image cache are complete; build ownership from the same token set and anchor.
    if (
        collection.bootstrapLastSyncedBlock === null ||
        collection.bootstrapLastSyncedBlock < payload.anchorBlock
    ) {
        bootstrapRuns.updateRunStatus(
            payload.runId,
            BOOTSTRAP_RUN_STATUS.Ownership,
        );
        const tokenIds = bootstrapStorage.listMetadataTaskTokenIds(
            payload.runId,
        );
        bootstrapSteps.markStepRunning(
            payload.runId,
            BOOTSTRAP_STEP_KEY.Ownership,
        );
        bootstrapSteps.updateStepProgress(
            payload.runId,
            BOOTSTRAP_STEP_KEY.Ownership,
            {
                completed: 0,
                total: tokenIds.length,
            },
        );
        await snapshotOwners(
            rpc,
            bootstrapStorage,
            payload.runId,
            payload.chainId,
            payload.collectionId,
            payload.address,
            payload.anchorBlock,
            tokenIds,
            snapshotBatchSize,
            (completed) => {
                bootstrapSteps.updateStepProgress(
                    payload.runId,
                    BOOTSTRAP_STEP_KEY.Ownership,
                    {
                        completed,
                        total: tokenIds.length,
                    },
                );
            },
        );

        bootstrapStorage.finalizeSnapshot({
            runId: payload.runId,
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
            action: "continueBootstrapAfterMediaCache",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            anchorBlock: payload.anchorBlock,
            tokenCount: tokenIds.length,
        });
        bootstrapSteps.markStepSucceeded(
            payload.runId,
            BOOTSTRAP_STEP_KEY.Ownership,
            {
                completed: tokenIds.length,
                total: tokenIds.length,
            },
        );
    }

    await ensureBackfillScheduled(
        rpc,
        queue,
        collections,
        bootstrapRuns,
        bootstrapSteps,
        payload,
        backfillBatchSize,
        openSeaIntegration,
        traceId,
        sourceJobId,
    );
}

async function ensureBackfillScheduled(
    rpc: RpcProviderPort,
    queue: QueuePort,
    collections: CollectionRegistryPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    payload: BootstrapMetadataProcessPayload | BootstrapImageCacheProcessPayload,
    backfillBatchSize: number,
    openSeaIntegration: OpenSeaIntegrationStatus,
    traceId: string,
    sourceJobId: string,
): Promise<void> {
    await maybeScheduleOpenSeaBootstrap(
        queue,
        collections,
        bootstrapRuns,
        payload,
        openSeaIntegration,
    );

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
            bootstrapSteps.markStepSkipped(
                payload.runId,
                BOOTSTRAP_STEP_KEY.Backfill,
                "no post-anchor blocks",
            );
            bootstrapSteps.markStepSucceeded(
                payload.runId,
                BOOTSTRAP_STEP_KEY.CollectionLive,
            );
            bootstrapRuns.updateRunStatus(
                payload.runId,
                BOOTSTRAP_RUN_STATUS.Completed,
            );
            bootstrapRuns.appendRunEvent({
                runId: payload.runId,
                chainId: payload.chainId,
                collectionId: payload.collectionId,
                eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunCompleted,
                eventLevel: "info",
                message: "Bootstrap completed without post-anchor backfill",
                payloadJson: JSON.stringify({
                    anchorBlock: payload.anchorBlock,
                    head,
                }),
            });
        }
        if (updated) {
            await publishMetadataStatsRecompute(
                queue,
                {
                    chainId: payload.chainId,
                    collectionId: payload.collectionId,
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
    bootstrapSteps.markStepRunning(payload.runId, BOOTSTRAP_STEP_KEY.Backfill);
    bootstrapSteps.updateStepProgress(
        payload.runId,
        BOOTSTRAP_STEP_KEY.Backfill,
        {
            completed: 0,
            total: head - fromBlock + 1,
        },
    );
    bootstrapRuns.updateRunStatus(payload.runId, BOOTSTRAP_RUN_STATUS.Backfill);
    bootstrapRuns.appendRunEvent({
        runId: payload.runId,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        eventCode: BOOTSTRAP_RUN_EVENT_CODE.BackfillQueued,
        eventLevel: "info",
        message: "Bootstrap backfill queued",
        payloadJson: JSON.stringify({
            fromBlock,
            toBlock: head,
        }),
    });
    await scheduleBackfillCheck(queue, {
        chainId: payload.chainId,
        runId: payload.runId,
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

async function maybeScheduleOpenSeaBootstrap(
    queue: QueuePort,
    collections: CollectionRegistryPort,
    bootstrapRuns: BootstrapRunsPort,
    payload: BootstrapMetadataProcessPayload | BootstrapImageCacheProcessPayload,
    openSeaIntegration: OpenSeaIntegrationStatus,
): Promise<void> {
    if (!openSeaIntegration.enabled) {
        bootstrapRuns.appendRunEvent({
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.OpenSeaSkipped,
            eventLevel: "info",
            message:
                "OpenSea bootstrap skipped because integration is disabled",
            payloadJson: JSON.stringify({
                reason: openSeaIntegration.reason,
                missingKeys: openSeaIntegration.missingKeys,
            }),
        });
        return;
    }

    const collection = collections.getCollection(
        payload.chainId,
        payload.collectionId,
    );
    if (!collection?.openseaSlug) {
        bootstrapRuns.appendRunEvent({
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.OpenSeaSkipped,
            eventLevel: "info",
            message:
                "OpenSea bootstrap skipped because no OpenSea slug is configured",
            payloadJson: null,
        });
        return;
    }

    collections.markOpenSeaPending(payload.chainId, payload.collectionId);
    await scheduleOpenSeaBootstrap(queue, {
        chainId: payload.chainId,
        collectionId: payload.collectionId,
    });
}

async function handleBootstrapBackfillCheck(
    queue: QueuePort,
    storage: StoragePort,
    collections: CollectionRegistryPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    payload: BootstrapBackfillCheckPayload,
    traceId: string,
    sourceJobId: string,
): Promise<void> {
    const expected = payload.toBlock - payload.fromBlock + 1;
    if (expected <= 0) {
        logger.warn("Bootstrap backfill check skipped (invalid range)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapBackfillCheck",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            fromBlock: payload.fromBlock,
            toBlock: payload.toBlock,
        });
        return;
    }

    const count = storage.countCollectionSyncedBlocksInRange(
        payload.chainId,
        payload.collectionId,
        payload.fromBlock,
        payload.toBlock,
    );
    bootstrapSteps.updateStepProgress(
        payload.runId,
        BOOTSTRAP_STEP_KEY.Backfill,
        {
            completed: count,
            total: expected,
        },
    );
    if (count < expected) {
        logger.debug("Bootstrap backfill incomplete; retrying", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapBackfillCheck",
            runId: payload.runId,
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
            runId: payload.runId,
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
        runId: payload.runId,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        fromBlock: payload.fromBlock,
        toBlock: payload.toBlock,
    });
    bootstrapSteps.markStepSucceeded(payload.runId, BOOTSTRAP_STEP_KEY.Backfill, {
        completed: expected,
        total: expected,
    });
    bootstrapSteps.markStepSucceeded(
        payload.runId,
        BOOTSTRAP_STEP_KEY.CollectionLive,
    );
    bootstrapRuns.updateRunStatus(
        payload.runId,
        BOOTSTRAP_RUN_STATUS.Completed,
    );
    bootstrapRuns.appendRunEvent({
        runId: payload.runId,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunCompleted,
        eventLevel: "info",
        message: "Bootstrap backfill complete; collection live",
        payloadJson: JSON.stringify({
            fromBlock: payload.fromBlock,
            toBlock: payload.toBlock,
        }),
    });

    await publishMetadataStatsRecompute(
        queue,
        {
            chainId: payload.chainId,
            collectionId: payload.collectionId,
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
        jobId: `bootstrap:metadata:${payload.chainId}:${payload.runId}:${scheduledAt}:${nonce}`,
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

async function scheduleImageCacheProcess(
    queue: QueuePort,
    payload: BootstrapImageCacheProcessPayload,
    traceId: string,
    delayMs: number,
): Promise<void> {
    const nonce = Math.floor(Math.random() * 1_000_000_000);
    const scheduledAt = Date.now() + Math.max(0, delayMs);
    const job: JobEnvelope<BootstrapImageCacheProcessPayload> = {
        jobId: `bootstrap:image-cache:${payload.chainId}:${payload.runId}:${scheduledAt}:${nonce}`,
        kind: BOOTSTRAP_JOB_KIND.ImageCacheProcess,
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
    collectionId: number,
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
            payload: {
                fromBlock: start,
                toBlock: end,
                source: BACKFILL_SOURCE.BootstrapCatchup,
                orderMaintenancePolicy:
                    BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
            },
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
        jobId: `bootstrap:check:${payload.chainId}:${payload.runId}:${Date.now()}`,
        kind: BOOTSTRAP_JOB_KIND.BackfillCheck,
        queue: QUEUE_NAMES.CollectionBootstrap,
        payload,
        attempt: 0,
        scheduledAt: Date.now() + BOOTSTRAP_BACKFILL_CHECK_DELAY_MS,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
    };
    await queue.publish(QUEUE_NAMES.CollectionBootstrap, job);
}

async function scheduleOpenSeaBootstrap(
    queue: QueuePort,
    payload: OpenSeaBootstrapCollectionPayload,
): Promise<void> {
    const job: JobEnvelope<OpenSeaBootstrapCollectionPayload> = {
        jobId: `opensea:bootstrap:${payload.chainId}:${payload.collectionId}`,
        kind: OPENSEA_JOB_KIND.BootstrapCollection,
        queue: QUEUE_NAMES.OpenSeaBootstrap,
        payload,
        attempt: 0,
        scheduledAt: Date.now(),
        chainId: payload.chainId,
        collectionId: payload.collectionId,
    };
    await queue.publish(QUEUE_NAMES.OpenSeaBootstrap, job);
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
    onProgress?: (progress: { resolved: number; total: number }) => void,
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
    onProgress?.({ resolved: 0, total: supply });
    for (let index = 0; index < supply; index += 1) {
        const tokenId = await rpc.readContract<bigint>({
            address: contract,
            abi: ERC721_ENUMERABLE_ABI,
            functionName: "tokenByIndex",
            args: [BigInt(index)],
            blockNumber: anchorBlock,
        });
        tokenIds.push(tokenId.toString());
        const resolved = index + 1;
        if (
            resolved === supply ||
            resolved % TOKEN_ENUMERATION_PROGRESS_STEP === 0
        ) {
            onProgress?.({ resolved, total: supply });
        }
    }
    return tokenIds;
}

async function resolveTokenIdsForRun(
    rpc: RpcProviderPort,
    run: {
        requestAddress: string;
        enumerationMode: "enumerable" | "manual_token_ids" | "manual_range";
        manualTokenIdsJson: string | null;
        manualRangeStartTokenId: string | null;
        manualRangeTotalSupply: number | null;
    },
    anchorBlock: number,
    onProgress?: (progress: { resolved: number; total: number | null }) => void,
): Promise<string[]> {
    if (run.enumerationMode === "enumerable") {
        return enumerateTokenIds(
            rpc,
            run.requestAddress as Hex,
            anchorBlock,
            onProgress,
        );
    }

    if (run.enumerationMode === "manual_token_ids") {
        if (!run.manualTokenIdsJson) {
            throw new Error("manual_token_ids mode requires tokenIds payload");
        }
        const parsed = JSON.parse(run.manualTokenIdsJson) as unknown;
        if (!Array.isArray(parsed) || parsed.length === 0) {
            throw new Error("manual_token_ids payload is empty");
        }
        const tokenIds: string[] = [];
        for (const value of parsed) {
            if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
                throw new Error(
                    "manual_token_ids payload contains invalid token id",
                );
            }
            tokenIds.push(value.trim());
        }
        onProgress?.({ resolved: tokenIds.length, total: tokenIds.length });
        return tokenIds;
    }

    if (
        run.enumerationMode === "manual_range" &&
        run.manualRangeStartTokenId &&
        run.manualRangeTotalSupply &&
        Number.isInteger(run.manualRangeTotalSupply) &&
        run.manualRangeTotalSupply > 0
    ) {
        const start = BigInt(run.manualRangeStartTokenId);
        const total = run.manualRangeTotalSupply;
        const tokenIds: string[] = [];
        for (let index = 0; index < total; index += 1) {
            tokenIds.push((start + BigInt(index)).toString());
        }
        onProgress?.({ resolved: tokenIds.length, total: tokenIds.length });
        return tokenIds;
    }

    throw new Error(
        `Unsupported enumeration mode: ${String(run.enumerationMode)}`,
    );
}

async function snapshotOwners(
    rpc: RpcProviderPort,
    bootstrapStorage: BootstrapSnapshotPort,
    runId: number,
    chainId: number,
    collectionId: number,
    contract: string,
    anchorBlock: number,
    tokenIds: string[],
    batchSize: number,
    onProgress?: (completed: number) => void,
): Promise<void> {
    // Snapshot ownership at the anchor block and write to the temporary snapshot table.
    const batch: Array<{
        runId: number;
        chainId: number;
        collectionId: number;
        contract: string;
        tokenId: string;
        owner: string;
        anchorBlock: number;
    }> = [];
    let completed = 0;
    const flush = () => {
        if (batch.length === 0) return;
        completed += batch.length;
        bootstrapStorage.insertSnapshotRows(batch.splice(0, batch.length));
        onProgress?.(completed);
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
            runId,
            chainId,
            collectionId,
            contract,
            tokenId,
            owner: owner.toLowerCase(),
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
