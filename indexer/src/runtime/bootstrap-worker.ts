import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { BOOTSTRAP_JOB_ID_SCOPE } from "@artgod/shared/bootstrap/jobs";
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
    isBootstrapStepTerminalStatus,
    type BootstrapEnumerationMode,
    type BootstrapStepKey,
    type BootstrapTaskCounts,
} from "@artgod/shared/bootstrap/pipeline";
import {
    isImageCachePolicyActive,
    type ImageCacheMode,
} from "@artgod/shared/media/token-image-cache";
import { ERC721_ENUMERABLE_ABI } from "../abi/index.js";
import { publishCollectionExtensionRefreshArtifacts } from "../application/collection-extensions/jobs.js";
import {
    BOOTSTRAP_STARTUP_RECONCILE_OUTCOME,
    BootstrapStartupReconciler,
    type BootstrapStartupReconcileRunResult,
} from "../application/bootstrap-startup-reconciler.js";
import {
    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME,
    BootstrapBackfillExecutor,
    cleanupSuccessfulBootstrapTemporaryData,
    type BootstrapBackfillCheckResult,
    type BootstrapBackfillQueuePort,
    type BootstrapBackfillScheduleResult,
    type BootstrapTemporaryDataCleanupResult,
} from "../application/bootstrap-backfill-executor.js";
import {
    BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME,
    BootstrapAnchorExecutor,
    type BootstrapAnchorExecutorResult,
} from "../application/bootstrap-anchor-executor.js";
import { resolveManualBootstrapTokenIds } from "../application/bootstrap-token-enumeration.js";
import { runWorker } from "../application/worker-runner.js";
import { publishMetadataStatsRecompute } from "../application/metadata/stats-recompute.js";
import { loadConfig } from "../config/index.js";
import type {
    BootstrapImageCacheProcessPayload,
    BootstrapMetadataSnapshotMode,
    BootstrapMetadataProcessPayload,
    BootstrapOwnershipProcessPayload,
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
import { COLLECTION_STANDARD } from "../domain/collections.js";
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
    BootstrapOwnershipTask,
    BootstrapOwnershipTaskSeed,
} from "../ports/bootstrap.js";
import type {
    BootstrapRunDefinition,
    BootstrapRunsPort,
} from "../ports/bootstrap-runs.js";
import type { BootstrapStepsPort } from "../ports/bootstrap-steps.js";
import type { CollectionRegistryPort } from "../ports/collections.js";
import type { CollectionExtensionInstallPort } from "../ports/collection-extensions.js";
import type { MetadataRefreshPayload } from "../domain/domain-jobs.js";
import type { TokenImageCachePort } from "../ports/token-image-cache.js";
import type { QueuePort } from "../ports/queue.js";
import type { Hex, RpcProviderPort } from "../ports/rpc.js";
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
const BOOTSTRAP_STARTUP_SWEEP_RUN_LIMIT = 100;
const BOOTSTRAP_STARTUP_SWEEP_TRACE_PREFIX = "bootstrap:startup-sweep";

const BOOTSTRAP_WORKER_COMPONENT = "CollectionBootstrapWorker";
const BOOTSTRAP_WORKER_ACTION = {
    StartupSweep: "reconcileActiveBootstrapRuns",
    StartupRun: "reconcileActiveBootstrapRun",
    StartupStepWake: "wakeBootstrapStep",
} as const;

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
        const bootstrapAnchorExecutor = new BootstrapAnchorExecutor(
            rpc,
            bootstrapRuns,
            bootstrapSteps,
            collections,
        );
        const bootstrapBackfillExecutor = new BootstrapBackfillExecutor(
            rpc,
            storage,
            collections,
            bootstrapRuns,
            bootstrapSteps,
            bootstrapStorage,
            createBootstrapBackfillQueuePort(queue),
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

        await reconcileActiveBootstrapRuns(
            queue,
            bootstrapStorage,
            bootstrapRuns,
            bootstrapSteps,
            bootstrapBackfillExecutor,
            config.sync.backfillBatchSize,
            config.integrations.opensea,
            config.chainId,
            BOOTSTRAP_STARTUP_SWEEP_RUN_LIMIT,
        );

        const stopBootstrap = await runWorker(
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
                    | BootstrapOwnershipProcessPayload
                    | BootstrapBackfillCheckPayload
                >,
            ) => {
                try {
                    if (job.kind === BOOTSTRAP_JOB_KIND.Start) {
                        await handleBootstrapStart(
                            bootstrapAnchorExecutor,
                            rpc,
                            queue,
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
                            queue,
                            collections,
                            collectionExtensions,
                            bootstrapStorage,
                            bootstrapRuns,
                            bootstrapSteps,
                            bootstrapBackfillExecutor,
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

                    if (job.kind === BOOTSTRAP_JOB_KIND.OwnershipProcess) {
                        await handleBootstrapOwnershipProcess(
                            rpc,
                            queue,
                            collections,
                            bootstrapStorage,
                            bootstrapRuns,
                            bootstrapSteps,
                            bootstrapBackfillExecutor,
                            config.sync.backfillBatchSize,
                            config.bootstrap.snapshotBatchSize,
                            config.bootstrap.metadataRetryPolicy,
                            config.integrations.opensea,
                            job.payload as BootstrapOwnershipProcessPayload,
                            job.traceId ?? job.jobId,
                            job.jobId,
                        );
                        return;
                    }

                    if (job.kind === BOOTSTRAP_JOB_KIND.BackfillCheck) {
                        await handleBootstrapBackfillCheck(
                            bootstrapBackfillExecutor,
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
        const stopImageCache = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.CollectionBootstrapImageCache,
                consumerName: `collection-bootstrap-image-cache-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (job: JobEnvelope<BootstrapImageCacheProcessPayload>) => {
                try {
                    if (job.kind !== BOOTSTRAP_JOB_KIND.ImageCacheProcess) {
                        logger.warn("Bootstrap image-cache lane skipped unknown job", {
                            component: "CollectionBootstrapWorker",
                            action: "handleBootstrapImageCacheLaneJob",
                            jobKind: job.kind,
                            jobId: job.jobId,
                        });
                        return;
                    }
                    await handleBootstrapImageCacheProcess(
                        queue,
                        collections,
                        bootstrapStorage,
                        bootstrapRuns,
                        bootstrapSteps,
                        tokenImageCache,
                        config.bootstrap.imageCacheBatchSize,
                        config.bootstrap.imageCacheConcurrency,
                        config.bootstrap.metadataRetryPolicy,
                        job.payload,
                        job.traceId ?? job.jobId,
                    );
                } catch (error) {
                    const runId = Number(
                        (job.payload as { runId?: unknown }).runId,
                    );
                    if (Number.isInteger(runId) && job.attempt >= 5) {
                        const run = bootstrapRuns.getRun(runId);
                        const message = String(error);
                        bootstrapSteps.markStepFailedTerminal({
                            runId,
                            stepKey: BOOTSTRAP_STEP_KEY.ImageCache,
                            attempts: Math.max(1, job.attempt),
                            error: message,
                        });
                        if (run) {
                            bootstrapRuns.appendRunEvent({
                                runId,
                                chainId: run.chainId,
                                collectionId: run.collectionId,
                                eventCode: BOOTSTRAP_RUN_EVENT_CODE.ImageCacheFailed,
                                eventLevel: "error",
                                message:
                                    "Bootstrap image cache failed after max retry attempts",
                                payloadJson: JSON.stringify({
                                    error: message,
                                    sourceJobId: job.jobId,
                                }),
                            });
                        }
                        return;
                    }
                    throw error;
                }
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.bootstrap.image_cache.consume",
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
            await stopBootstrap();
            await stopImageCache();
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

function createBootstrapBackfillQueuePort(
    queue: QueuePort,
): BootstrapBackfillQueuePort {
    return {
        scheduleBackfillRange: async (input) => {
            await scheduleBackfillRange(
                queue,
                input.chainId,
                input.collectionId,
                input.fromBlock,
                input.toBlock,
                input.batchSize,
            );
        },
        scheduleBackfillCheck: async (input) => {
            await scheduleBackfillCheck(queue, input);
        },
        scheduleOpenSeaBootstrap: async (input) => {
            await scheduleOpenSeaBootstrap(queue, input);
        },
        publishMetadataStatsRecompute: async (input) => {
            await publishMetadataStatsRecompute(
                queue,
                input.payload,
                input.traceId,
            );
        },
    };
}

async function reconcileActiveBootstrapRuns(
    queue: QueuePort,
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    backfillExecutor: BootstrapBackfillExecutor,
    backfillBatchSize: number,
    openSeaIntegration: OpenSeaIntegrationStatus,
    chainId: number,
    sweepRunLimit: number,
): Promise<void> {
    const traceId = `${BOOTSTRAP_STARTUP_SWEEP_TRACE_PREFIX}:${Date.now()}`;
    const reconciler = new BootstrapStartupReconciler(
        bootstrapRuns,
        bootstrapSteps,
        {
            wakeBootstrapStep: async ({ run, stepKey, traceId: wakeTraceId }) => {
                await wakeBootstrapStep(
                    queue,
                    bootstrapStorage,
                    backfillExecutor,
                    backfillBatchSize,
                    openSeaIntegration,
                    run,
                    stepKey,
                    wakeTraceId,
                );
            },
        },
    );
    logger.info("Bootstrap startup sweep started", {
        component: BOOTSTRAP_WORKER_COMPONENT,
        action: BOOTSTRAP_WORKER_ACTION.StartupSweep,
        chainId,
        sweepRunLimit,
    });

    const result = await reconciler.reconcile({
        chainId,
        limit: sweepRunLimit,
        traceId,
    });
    for (const runResult of result.runs) {
        logBootstrapStartupRunResult(runResult);
    }

    logger.info("Bootstrap startup sweep completed", {
        component: BOOTSTRAP_WORKER_COMPONENT,
        action: BOOTSTRAP_WORKER_ACTION.StartupSweep,
        chainId,
        sweepRunCount: result.runs.length,
    });
}

function logBootstrapStartupRunResult(
    result: BootstrapStartupReconcileRunResult,
): void {
    const { run } = result;
    if (result.outcome === BOOTSTRAP_STARTUP_RECONCILE_OUTCOME.Failed) {
        logger.warn("Bootstrap startup sweep skipped run after error", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.StartupRun,
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            outcome: result.outcome,
            error: result.error,
        });
        return;
    }

    if (result.outcome === BOOTSTRAP_STARTUP_RECONCILE_OUTCOME.NoSteps) {
        logger.warn("Bootstrap startup sweep skipped run without steps", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.StartupRun,
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            outcome: result.outcome,
        });
        return;
    }

    if (result.outcome === BOOTSTRAP_STARTUP_RECONCILE_OUTCOME.Idle) {
        logger.debug("Bootstrap startup sweep found no wakeable steps", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.StartupRun,
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            outcome: result.outcome,
            readyStepKeys: result.readyStepKeys,
        });
        return;
    }

    logger.info("Bootstrap startup sweep waking run steps", {
        component: BOOTSTRAP_WORKER_COMPONENT,
        action: BOOTSTRAP_WORKER_ACTION.StartupRun,
        runId: run.runId,
        chainId: run.chainId,
        collectionId: run.collectionId,
        outcome: result.outcome,
        readyStepKeys: result.readyStepKeys,
        wakeableStepKeys: result.wakeableStepKeys,
    });
}

async function wakeBootstrapStep(
    queue: QueuePort,
    bootstrapStorage: BootstrapSnapshotPort,
    backfillExecutor: BootstrapBackfillExecutor,
    backfillBatchSize: number,
    openSeaIntegration: OpenSeaIntegrationStatus,
    run: BootstrapRunDefinition,
    stepKey: BootstrapStepKey,
    traceId: string,
): Promise<void> {
    if (
        stepKey === BOOTSTRAP_STEP_KEY.Anchor ||
        stepKey === BOOTSTRAP_STEP_KEY.Enumeration
    ) {
        await scheduleBootstrapStart(
            queue,
            buildBootstrapCollectionPayload(run),
            traceId,
        );
        return;
    }

    if (stepKey === BOOTSTRAP_STEP_KEY.Metadata) {
        const metadataCounts = bootstrapStorage.getMetadataTaskCounts(run.runId);
        if (metadataCounts.total <= 0) {
            await scheduleBootstrapStart(
                queue,
                buildBootstrapCollectionPayload(run),
                traceId,
            );
            logger.info("Bootstrap startup sweep queued start for metadata seed", {
                component: BOOTSTRAP_WORKER_COMPONENT,
                action: BOOTSTRAP_WORKER_ACTION.StartupStepWake,
                runId: run.runId,
                chainId: run.chainId,
                collectionId: run.collectionId,
                stepKey,
            });
            return;
        }
        const anchoredRun = getAnchoredBootstrapRun(run);
        if (!anchoredRun) {
            logMissingAnchorForWake(run, stepKey);
            return;
        }
        await scheduleMetadataProcess(
            queue,
            buildMetadataProcessPayload(anchoredRun),
            traceId,
            0,
        );
        return;
    }

    const anchoredRun = getAnchoredBootstrapRun(run);
    if (!anchoredRun) {
        logMissingAnchorForWake(run, stepKey);
        return;
    }

    if (stepKey === BOOTSTRAP_STEP_KEY.ImageCache) {
        await scheduleImageCacheProcess(
            queue,
            buildImageCacheProcessPayload(anchoredRun),
            traceId,
            0,
        );
        return;
    }

    if (stepKey === BOOTSTRAP_STEP_KEY.Ownership) {
        await scheduleOwnershipProcess(
            queue,
            buildOwnershipProcessPayload(anchoredRun),
            traceId,
        );
        return;
    }

    if (stepKey === BOOTSTRAP_STEP_KEY.Backfill) {
        await scheduleBackfillAfterSnapshot(
            backfillExecutor,
            buildOwnershipProcessPayload(anchoredRun),
            backfillBatchSize,
            openSeaIntegration,
            traceId,
            traceId,
        );
        return;
    }

    logger.debug("Bootstrap startup sweep skipped step without local executor", {
        component: BOOTSTRAP_WORKER_COMPONENT,
        action: BOOTSTRAP_WORKER_ACTION.StartupStepWake,
        runId: run.runId,
        chainId: run.chainId,
        collectionId: run.collectionId,
        stepKey,
    });
}

function getAnchoredBootstrapRun(
    run: BootstrapRunDefinition,
): (BootstrapRunDefinition & {
    anchorBlock: number;
    anchorBlockHash: string;
    anchorBlockTimestamp: number;
}) | null {
    if (
        run.anchorBlock === null ||
        !run.anchorBlockHash ||
        run.anchorBlockTimestamp === null
    ) {
        return null;
    }
    return run as BootstrapRunDefinition & {
        anchorBlock: number;
        anchorBlockHash: string;
        anchorBlockTimestamp: number;
    };
}

function logMissingAnchorForWake(
    run: BootstrapRunDefinition,
    stepKey: BootstrapStepKey,
): void {
    logger.warn("Bootstrap startup sweep skipped step without anchor", {
        component: BOOTSTRAP_WORKER_COMPONENT,
        action: BOOTSTRAP_WORKER_ACTION.StartupStepWake,
        runId: run.runId,
        chainId: run.chainId,
        collectionId: run.collectionId,
        stepKey,
    });
}

function buildBootstrapCollectionPayload(
    run: BootstrapRunDefinition,
): BootstrapCollectionPayload {
    return {
        chainId: run.chainId,
        runId: run.runId,
        collectionId: run.collectionId,
    };
}

function buildMetadataProcessPayload(
    run: BootstrapRunDefinition & {
        anchorBlock: number;
        anchorBlockHash: string;
        anchorBlockTimestamp: number;
    },
): BootstrapMetadataProcessPayload {
    return {
        chainId: run.chainId,
        runId: run.runId,
        collectionId: run.collectionId,
        address: run.requestAddress,
        standard: run.requestStandard,
        metadataSnapshotMode: run.metadataMode,
        anchorBlock: run.anchorBlock,
        anchorHash: run.anchorBlockHash,
        anchorTimestamp: run.anchorBlockTimestamp,
    };
}

function buildImageCacheProcessPayload(
    run: BootstrapRunDefinition & {
        anchorBlock: number;
        anchorBlockHash: string;
        anchorBlockTimestamp: number;
    },
): BootstrapImageCacheProcessPayload {
    return {
        chainId: run.chainId,
        runId: run.runId,
        collectionId: run.collectionId,
        address: run.requestAddress,
        standard: run.requestStandard,
        anchorBlock: run.anchorBlock,
        anchorHash: run.anchorBlockHash,
        anchorTimestamp: run.anchorBlockTimestamp,
    };
}

function buildOwnershipProcessPayload(
    run: BootstrapRunDefinition & {
        anchorBlock: number;
        anchorBlockHash: string;
        anchorBlockTimestamp: number;
    },
): BootstrapOwnershipProcessPayload {
    return {
        chainId: run.chainId,
        runId: run.runId,
        collectionId: run.collectionId,
        address: run.requestAddress,
        standard: run.requestStandard,
        anchorBlock: run.anchorBlock,
        anchorHash: run.anchorBlockHash,
        anchorTimestamp: run.anchorBlockTimestamp,
    };
}

function logBootstrapAnchorResult(result: BootstrapAnchorExecutorResult): void {
    if (
        result.outcome ===
        BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.UnsupportedStandard
    ) {
        logger.warn("Bootstrap skipped (unsupported standard)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            runId: result.run.runId,
            chainId: result.run.chainId,
            collectionId: result.run.collectionId,
            standard: result.run.requestStandard,
        });
        return;
    }

    if (result.outcome === BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.InvalidAnchor) {
        logger.warn("Bootstrap skipped (invalid anchor block)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            runId: result.run.runId,
            chainId: result.run.chainId,
            collectionId: result.run.collectionId,
        });
        return;
    }

    if (result.outcome === BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.CollectionMissing) {
        logger.warn("Bootstrap skipped (collection missing)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            runId: result.run.runId,
            chainId: result.run.chainId,
            collectionId: result.run.collectionId,
            anchorBlock: result.anchor?.anchorBlock,
        });
    }
}

async function handleBootstrapStart(
    anchorExecutor: BootstrapAnchorExecutor,
    rpc: RpcProviderPort,
    queue: QueuePort,
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
    if (
        run.status === BOOTSTRAP_RUN_STATUS.Completed ||
        run.status === BOOTSTRAP_RUN_STATUS.Failed
    ) {
        logger.debug("Bootstrap start skipped (run already terminal)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapStart",
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            status: run.status,
        });
        return;
    }

    const anchorStep = bootstrapSteps.getStep(
        run.runId,
        BOOTSTRAP_STEP_KEY.Anchor,
    );
    const enumerationStep = bootstrapSteps.getStep(
        run.runId,
        BOOTSTRAP_STEP_KEY.Enumeration,
    );
    if (
        anchorStep &&
        enumerationStep &&
        isBootstrapStepTerminalStatus(anchorStep.status) &&
        isBootstrapStepTerminalStatus(enumerationStep.status)
    ) {
        const metadataCounts = bootstrapStorage.getMetadataTaskCounts(run.runId);
        const anchoredRun = getAnchoredBootstrapRun(run);
        if (anchoredRun && metadataCounts.total > 0) {
            await scheduleMetadataProcess(
                queue,
                buildMetadataProcessPayload(anchoredRun),
                traceId,
                0,
            );
            logger.info("Bootstrap start woke existing metadata tasks", {
                component: "CollectionBootstrapWorker",
                action: "handleBootstrapStart",
                runId: run.runId,
                chainId: run.chainId,
                collectionId: run.collectionId,
                metadataTasks: metadataCounts.total,
            });
            return;
        }
    }

    const anchorResult = await anchorExecutor.anchor({ run, reorgDepth });
    logBootstrapAnchorResult(anchorResult);
    if (anchorResult.outcome !== BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.Anchored) {
        return;
    }
    const anchorBlock = anchorResult.anchor.anchorBlock;
    const anchorHash = anchorResult.anchor.anchorHash;
    const anchorTimestamp = anchorResult.anchor.anchorTimestamp;

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
                    standard: COLLECTION_STANDARD.Erc721,
                    anchorBlock,
                    anchorHash,
                    anchorTimestamp,
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
                anchorHash,
                anchorTimestamp,
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
    queue: QueuePort,
    collections: CollectionRegistryPort,
    collectionExtensions: CollectionExtensionInstallPort,
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    backfillExecutor: BootstrapBackfillExecutor,
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
    if (payload.standard !== COLLECTION_STANDARD.Erc721) {
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

    bootstrapSteps.markStepSucceeded(run.runId, BOOTSTRAP_STEP_KEY.Metadata, {
        completed: counts.total,
        total: counts.total,
    });
    await scheduleImageCacheSideLaneIfNeeded(
        queue,
        bootstrapStorage,
        bootstrapRuns,
        bootstrapSteps,
        run,
        payload,
        traceId,
    );

    await continueBlockingBootstrapAfterMetadata(
        queue,
        collections,
        bootstrapStorage,
        bootstrapRuns,
        bootstrapSteps,
        backfillExecutor,
        backfillBatchSize,
        snapshotBatchSize,
        openSeaIntegration,
        payload,
        traceId,
        sourceJobId,
    );
}

async function scheduleImageCacheSideLaneIfNeeded(
    queue: QueuePort,
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    run: {
        runId: number;
        chainId: number;
        collectionId: number;
        imageCacheMode: ImageCacheMode;
        imageCacheMaxDimension: number | null;
    },
    payload: BootstrapMetadataProcessPayload,
    traceId: string,
): Promise<void> {
    if (!isRunImageCacheActive(run)) {
        return;
    }

    const seedState = ensureImageCacheTasksSeeded(
        bootstrapStorage,
        bootstrapRuns,
        bootstrapSteps,
        run,
    );
    if (!seedState) {
        return;
    }

    bootstrapSteps.markStepRunning(run.runId, BOOTSTRAP_STEP_KEY.ImageCache);
    bootstrapSteps.updateStepProgress(run.runId, BOOTSTRAP_STEP_KEY.ImageCache, {
        completed:
            seedState.counts.succeeded + seedState.counts.failedTerminal,
        total: seedState.counts.total,
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
}

type BootstrapImageCacheSeedState = {
    counts: BootstrapTaskCounts;
};

function ensureImageCacheTasksSeeded(
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    run: {
        runId: number;
        chainId: number;
        collectionId: number;
        imageCacheMode: ImageCacheMode;
        imageCacheMaxDimension: number | null;
    },
): BootstrapImageCacheSeedState | null {
    if (!isRunImageCacheActive(run)) {
        return null;
    }

    const existingCounts = bootstrapStorage.getImageCacheTaskCounts(run.runId);
    if (existingCounts.total > 0) {
        return {
            counts: existingCounts,
        };
    }

    const seeded = bootstrapStorage.seedImageCacheTasks({
        runId: run.runId,
        requestedMaxDimension: run.imageCacheMaxDimension,
    });
    const counts = bootstrapStorage.getImageCacheTaskCounts(run.runId);
    if (counts.total <= 0) {
        bootstrapRuns.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.ImageCacheSkipped,
            eventLevel: "info",
            message:
                "Bootstrap image cache skipped because no token images were available",
            payloadJson: null,
        });
        bootstrapSteps.markStepSkipped(
            run.runId,
            BOOTSTRAP_STEP_KEY.ImageCache,
            "no token images available",
        );
        return null;
    }

    bootstrapRuns.appendRunEvent({
        runId: run.runId,
        chainId: run.chainId,
        collectionId: run.collectionId,
        eventCode: BOOTSTRAP_RUN_EVENT_CODE.ImageCacheQueued,
        eventLevel: "info",
        message: "Bootstrap image cache side lane queued",
        payloadJson: JSON.stringify({
            seeded,
            total: counts.total,
            maxDimension: run.imageCacheMaxDimension,
        }),
    });

    return { counts };
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
    queue: QueuePort,
    collections: CollectionRegistryPort,
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    tokenImageCache: TokenImageCachePort,
    imageCacheBatchSize: number,
    imageCacheConcurrency: number,
    imageCacheRetryPolicy: RetryPolicy,
    payload: BootstrapImageCacheProcessPayload,
    traceId: string,
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

    const imageCacheStep = bootstrapSteps.getStep(
        payload.runId,
        BOOTSTRAP_STEP_KEY.ImageCache,
    );
    if (
        imageCacheStep &&
        isBootstrapStepTerminalStatus(imageCacheStep.status)
    ) {
        logger.debug("Image cache process skipped (step already terminal)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapImageCacheProcess",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            stepStatus: imageCacheStep.status,
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

    const run = bootstrapRuns.getRun(payload.runId);
    if (!run) {
        logger.warn("Image cache process skipped (run missing)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapImageCacheProcess",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return;
    }
    if (
        !ensureImageCacheTasksSeeded(
            bootstrapStorage,
            bootstrapRuns,
            bootstrapSteps,
            run,
        )
    ) {
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
    const cleanup = cleanupSuccessfulBootstrapTemporaryData({
        bootstrapStorage,
        bootstrapRuns,
        runId: payload.runId,
    });
    logBootstrapTemporaryDataCleanup(cleanup);
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
            standard: COLLECTION_STANDARD.Erc721,
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

function markOwnershipTaskFailed(
    bootstrapStorage: BootstrapSnapshotPort,
    task: BootstrapOwnershipTask,
    attempts: number,
    retryPolicy: RetryPolicy,
    error: string,
): void {
    const failedTerminal = attempts >= Math.max(1, retryPolicy.maxAttempts);
    const retryDelay = getRetryDelayMs(attempts, retryPolicy);
    bootstrapStorage.markOwnershipTaskRetry({
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

async function continueBlockingBootstrapAfterMetadata(
    queue: QueuePort,
    collections: CollectionRegistryPort,
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    backfillExecutor: BootstrapBackfillExecutor,
    backfillBatchSize: number,
    snapshotBatchSize: number,
    openSeaIntegration: OpenSeaIntegrationStatus,
    payload: BootstrapMetadataProcessPayload,
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
            action: "continueBlockingBootstrapAfterMetadata",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return;
    }

    // Metadata is complete; seed durable ownership tasks from the same token set and anchor.
    if (
        collection.bootstrapLastSyncedBlock === null ||
        collection.bootstrapLastSyncedBlock < payload.anchorBlock
    ) {
        bootstrapRuns.updateRunStatus(
            payload.runId,
            BOOTSTRAP_RUN_STATUS.Ownership,
        );
        const seededOwnershipCounts = ensureOwnershipTasksSeeded(
            bootstrapStorage,
            payload,
            snapshotBatchSize,
        );
        bootstrapSteps.markStepRunning(
            payload.runId,
            BOOTSTRAP_STEP_KEY.Ownership,
        );
        bootstrapSteps.updateStepProgress(
            payload.runId,
            BOOTSTRAP_STEP_KEY.Ownership,
            {
                completed:
                    seededOwnershipCounts.succeeded +
                    seededOwnershipCounts.failedTerminal,
                total: seededOwnershipCounts.total,
            },
        );
        await scheduleOwnershipProcess(
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
        );
        logger.info("Bootstrap ownership snapshot tasks queued", {
            component: "CollectionBootstrapWorker",
            action: "continueBlockingBootstrapAfterMetadata",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            anchorBlock: payload.anchorBlock,
            tokenCount: seededOwnershipCounts.total,
        });
        return;
    }

    bootstrapSteps.markStepSkipped(
        payload.runId,
        BOOTSTRAP_STEP_KEY.Ownership,
        "snapshot already current",
    );

    await scheduleBackfillAfterSnapshot(
        backfillExecutor,
        payload,
        backfillBatchSize,
        openSeaIntegration,
        traceId,
        sourceJobId,
    );
}

function ensureOwnershipTasksSeeded(
    bootstrapStorage: BootstrapSnapshotPort,
    payload: BootstrapMetadataProcessPayload | BootstrapOwnershipProcessPayload,
    snapshotBatchSize: number,
): BootstrapTaskCounts {
    const existingCounts = bootstrapStorage.getOwnershipTaskCounts(payload.runId);
    if (existingCounts.total > 0) {
        return existingCounts;
    }

    const tokenIds = bootstrapStorage.listMetadataTaskTokenIds(payload.runId);
    const writeBatchSize = Math.max(1, snapshotBatchSize);
    for (let cursor = 0; cursor < tokenIds.length; cursor += writeBatchSize) {
        const end = Math.min(tokenIds.length, cursor + writeBatchSize);
        const rows: BootstrapOwnershipTaskSeed[] = [];
        for (let index = cursor; index < end; index += 1) {
            rows.push({
                runId: payload.runId,
                chainId: payload.chainId,
                collectionId: payload.collectionId,
                contract: payload.address,
                standard: payload.standard,
                anchorBlock: payload.anchorBlock,
                anchorHash: payload.anchorHash as Hex,
                anchorTimestamp: payload.anchorTimestamp,
                tokenId: tokenIds[index]!,
            });
        }
        bootstrapStorage.insertOwnershipTasks(rows);
    }

    return bootstrapStorage.getOwnershipTaskCounts(payload.runId);
}

async function handleBootstrapOwnershipProcess(
    rpc: RpcProviderPort,
    queue: QueuePort,
    collections: CollectionRegistryPort,
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    backfillExecutor: BootstrapBackfillExecutor,
    backfillBatchSize: number,
    ownershipBatchSize: number,
    ownershipRetryPolicy: RetryPolicy,
    openSeaIntegration: OpenSeaIntegrationStatus,
    payload: BootstrapOwnershipProcessPayload,
    traceId: string,
    sourceJobId: string,
): Promise<void> {
    const collection = collections.getCollection(
        payload.chainId,
        payload.collectionId,
    );
    if (!collection) {
        logger.warn("Ownership process skipped (collection missing)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapOwnershipProcess",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return;
    }

    const ownershipStep = bootstrapSteps.getStep(
        payload.runId,
        BOOTSTRAP_STEP_KEY.Ownership,
    );
    if (ownershipStep && isBootstrapStepTerminalStatus(ownershipStep.status)) {
        logger.debug("Ownership process skipped (step already terminal)", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapOwnershipProcess",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            stepStatus: ownershipStep.status,
        });
        return;
    }

    if (
        collection.bootstrapLastSyncedBlock !== null &&
        collection.bootstrapLastSyncedBlock >= payload.anchorBlock
    ) {
        bootstrapSteps.markStepSkipped(
            payload.runId,
            BOOTSTRAP_STEP_KEY.Ownership,
            "snapshot already current",
        );
        await scheduleBackfillAfterSnapshot(
            backfillExecutor,
            payload,
            backfillBatchSize,
            openSeaIntegration,
            traceId,
            sourceJobId,
        );
        return;
    }

    const seededOwnershipCounts = ensureOwnershipTasksSeeded(
        bootstrapStorage,
        payload,
        ownershipBatchSize,
    );
    bootstrapSteps.markStepRunning(payload.runId, BOOTSTRAP_STEP_KEY.Ownership);
    bootstrapSteps.updateStepProgress(
        payload.runId,
        BOOTSTRAP_STEP_KEY.Ownership,
        {
            completed:
                seededOwnershipCounts.succeeded +
                seededOwnershipCounts.failedTerminal,
            total: seededOwnershipCounts.total,
        },
    );
    const processed = await processDueOwnershipTasks(
        rpc,
        bootstrapStorage,
        payload.runId,
        Math.max(1, ownershipBatchSize),
        ownershipRetryPolicy,
    );

    const counts = bootstrapStorage.getOwnershipTaskCounts(payload.runId);
    bootstrapSteps.updateStepProgress(
        payload.runId,
        BOOTSTRAP_STEP_KEY.Ownership,
        {
            completed: counts.succeeded + counts.failedTerminal,
            total: counts.total,
        },
    );
    if (counts.pending > 0 || counts.retry > 0) {
        const hasDueNow =
            bootstrapStorage.listOwnershipTasksDueNow(
                payload.runId,
                Date.now(),
                1,
            ).length > 0;
        await scheduleOwnershipProcess(
            queue,
            payload,
            traceId,
            hasDueNow ? 0 : 5_000,
        );
        logger.debug("Bootstrap ownership process progress", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapOwnershipProcess",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            processed,
            counts,
            nextDelayMs: hasDueNow ? 0 : 5_000,
        });
        return;
    }

    if (counts.failedTerminal > 0) {
        const message = "Bootstrap ownership snapshot has terminal failures";
        bootstrapSteps.markStepFailedTerminal({
            runId: payload.runId,
            stepKey: BOOTSTRAP_STEP_KEY.Ownership,
            attempts: Math.max(1, counts.failedTerminal),
            error: message,
        });
        bootstrapRuns.updateRunStatus(payload.runId, BOOTSTRAP_RUN_STATUS.Failed, {
            code: "ownership_snapshot_failed",
            message,
        });
        bootstrapRuns.appendRunEvent({
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunFailed,
            eventLevel: "error",
            message,
            payloadJson: JSON.stringify(counts),
        });
        return;
    }

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
    bootstrapSteps.markStepSucceeded(payload.runId, BOOTSTRAP_STEP_KEY.Ownership, {
        completed: counts.total,
        total: counts.total,
    });

    logger.info("Bootstrap ownership snapshot completed", {
        component: "CollectionBootstrapWorker",
        action: "handleBootstrapOwnershipProcess",
        runId: payload.runId,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        anchorBlock: payload.anchorBlock,
        tokenCount: counts.total,
    });

    await scheduleBackfillAfterSnapshot(
        backfillExecutor,
        payload,
        backfillBatchSize,
        openSeaIntegration,
        traceId,
        sourceJobId,
    );
}

async function processDueOwnershipTasks(
    rpc: RpcProviderPort,
    bootstrapStorage: BootstrapSnapshotPort,
    runId: number,
    ownershipBatchSize: number,
    retryPolicy: RetryPolicy,
): Promise<number> {
    const dueTasks = bootstrapStorage.listOwnershipTasksDueNow(
        runId,
        Date.now(),
        Math.max(1, ownershipBatchSize),
    );
    if (dueTasks.length === 0) {
        return 0;
    }

    for (const task of dueTasks) {
        await processSingleOwnershipTask(rpc, bootstrapStorage, task, retryPolicy);
    }
    return dueTasks.length;
}

async function processSingleOwnershipTask(
    rpc: RpcProviderPort,
    bootstrapStorage: BootstrapSnapshotPort,
    task: BootstrapOwnershipTask,
    retryPolicy: RetryPolicy,
): Promise<void> {
    const attempts = task.attempts + 1;
    try {
        const owner = await rpc.readContract<string>({
            address: task.contract as Hex,
            abi: ERC721_ENUMERABLE_ABI,
            functionName: "ownerOf",
            args: [BigInt(task.tokenId)],
            blockNumber: task.anchorBlock,
        });
        bootstrapStorage.markOwnershipTaskSucceeded({
            runId: task.runId,
            tokenId: task.tokenId,
            attempts,
            owner: owner.toLowerCase(),
        });
    } catch (error) {
        markOwnershipTaskFailed(
            bootstrapStorage,
            task,
            attempts,
            retryPolicy,
            String(error),
        );
    }
}

async function scheduleBackfillAfterSnapshot(
    backfillExecutor: BootstrapBackfillExecutor,
    payload: BootstrapMetadataProcessPayload | BootstrapOwnershipProcessPayload,
    backfillBatchSize: number,
    openSeaIntegration: OpenSeaIntegrationStatus,
    traceId: string,
    sourceJobId: string,
): Promise<void> {
    const result = await backfillExecutor.scheduleAfterSnapshot({
        chainId: payload.chainId,
        runId: payload.runId,
        collectionId: payload.collectionId,
        address: payload.address,
        anchorBlock: payload.anchorBlock,
        backfillBatchSize,
        openSeaIntegration,
        traceId,
        sourceJobId,
    });
    logBootstrapBackfillScheduleResult(result, payload);
    logBootstrapTemporaryDataCleanup(result.cleanup);
}

function logBootstrapBackfillScheduleResult(
    result: BootstrapBackfillScheduleResult,
    payload: BootstrapMetadataProcessPayload | BootstrapOwnershipProcessPayload,
): void {
    if (result.outcome === BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.InvalidRange) {
        logger.warn("Bootstrap backfill skipped (invalid range)", {
            component: "CollectionBootstrapWorker",
            action: "scheduleBackfillAfterSnapshot",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            fromBlock: result.fromBlock,
            anchorBlock: payload.anchorBlock,
        });
        return;
    }

    if (
        result.outcome ===
        BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.CollectionMissing
    ) {
        logger.warn("Bootstrap finish skipped (collection missing)", {
            component: "CollectionBootstrapWorker",
            action: "scheduleBackfillAfterSnapshot",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            anchorBlock: payload.anchorBlock,
        });
        return;
    }

    if (
        result.outcome ===
        BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.CompletedWithoutBackfill
    ) {
        logger.info("Bootstrap finished (no post-anchor blocks)", {
            component: "CollectionBootstrapWorker",
            action: "scheduleBackfillAfterSnapshot",
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            anchorBlock: payload.anchorBlock,
            head: result.headBlock,
        });
        return;
    }

    logger.info("Bootstrap backfill queued", {
        component: "CollectionBootstrapWorker",
        action: "scheduleBackfillAfterSnapshot",
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        fromBlock: result.plan?.fromBlock,
        toBlock:
            result.plan && "toBlock" in result.plan
                ? result.plan.toBlock
                : undefined,
    });
}

async function handleBootstrapBackfillCheck(
    backfillExecutor: BootstrapBackfillExecutor,
    payload: BootstrapBackfillCheckPayload,
    traceId: string,
    sourceJobId: string,
): Promise<void> {
    const result = await backfillExecutor.checkProgress({
        chainId: payload.chainId,
        runId: payload.runId,
        collectionId: payload.collectionId,
        address: payload.address,
        fromBlock: payload.fromBlock,
        toBlock: payload.toBlock,
        traceId,
        sourceJobId,
    });
    logBootstrapBackfillCheckResult(result, payload);
    logBootstrapTemporaryDataCleanup(result.cleanup);
}

function logBootstrapBackfillCheckResult(
    result: BootstrapBackfillCheckResult,
    payload: BootstrapBackfillCheckPayload,
): void {
    if (result.outcome === BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.InvalidRange) {
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

    if (
        result.outcome ===
        BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete
    ) {
        logger.debug("Bootstrap backfill incomplete; retrying", {
            component: "CollectionBootstrapWorker",
            action: "handleBootstrapBackfillCheck",
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            fromBlock: payload.fromBlock,
            toBlock: payload.toBlock,
            count: result.synced,
            expected: result.expected,
        });
        return;
    }

    if (
        result.outcome ===
        BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.CollectionMissing
    ) {
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
}

function logBootstrapTemporaryDataCleanup(
    cleanup: BootstrapTemporaryDataCleanupResult,
): void {
    if (!cleanup.deleted) {
        return;
    }

    logger.info("Bootstrap temporary data cleaned up", {
        component: "CollectionBootstrapWorker",
        action: "cleanupBootstrapTemporaryData",
        runId: cleanup.run.runId,
        chainId: cleanup.run.chainId,
        collectionId: cleanup.run.collectionId,
        metadataTasks: cleanup.metadataTasks,
        imageCacheTasks: cleanup.imageCacheTasks,
        ownershipTasks: cleanup.ownershipTasks,
    });
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
        jobId: `${BOOTSTRAP_JOB_ID_SCOPE.Metadata}:${payload.chainId}:${payload.runId}:${scheduledAt}:${nonce}`,
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

async function scheduleBootstrapStart(
    queue: QueuePort,
    payload: BootstrapCollectionPayload,
    traceId: string,
): Promise<void> {
    const nonce = Math.floor(Math.random() * 1_000_000_000);
    const scheduledAt = Date.now();
    const job: JobEnvelope<BootstrapCollectionPayload> = {
        jobId: `${BOOTSTRAP_JOB_ID_SCOPE.Start}:${payload.chainId}:${payload.runId}:${scheduledAt}:${nonce}`,
        kind: BOOTSTRAP_JOB_KIND.Start,
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
        jobId: `${BOOTSTRAP_JOB_ID_SCOPE.ImageCache}:${payload.chainId}:${payload.runId}:${scheduledAt}:${nonce}`,
        kind: BOOTSTRAP_JOB_KIND.ImageCacheProcess,
        queue: QUEUE_NAMES.CollectionBootstrapImageCache,
        payload,
        attempt: 0,
        scheduledAt,
        chainId: payload.chainId,
        traceId,
        collectionId: payload.collectionId,
    };
    await queue.publish(QUEUE_NAMES.CollectionBootstrapImageCache, job);
}

async function scheduleOwnershipProcess(
    queue: QueuePort,
    payload: BootstrapOwnershipProcessPayload,
    traceId: string,
    delayMs = 0,
): Promise<void> {
    const nonce = Math.floor(Math.random() * 1_000_000_000);
    const scheduledAt = Date.now() + Math.max(0, delayMs);
    const job: JobEnvelope<BootstrapOwnershipProcessPayload> = {
        jobId: `${BOOTSTRAP_JOB_ID_SCOPE.Ownership}:${payload.chainId}:${payload.runId}:${scheduledAt}:${nonce}`,
        kind: BOOTSTRAP_JOB_KIND.OwnershipProcess,
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
        jobId: `${BOOTSTRAP_JOB_ID_SCOPE.BackfillCheck}:${payload.chainId}:${payload.runId}:${Date.now()}`,
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
        enumerationMode: BootstrapEnumerationMode;
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

    const tokenIds = resolveManualBootstrapTokenIds(run);
    if (tokenIds) {
        onProgress?.({ resolved: tokenIds.length, total: tokenIds.length });
        return tokenIds;
    }

    throw new Error(
        `Unsupported enumeration mode: ${String(run.enumerationMode)}`,
    );
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
