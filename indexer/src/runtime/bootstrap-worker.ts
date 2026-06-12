import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { BOOTSTRAP_JOB_ID_SCOPE } from "@artgod/shared/bootstrap/jobs";
import type { OpenSeaIntegrationStatus } from "@artgod/shared/config/opensea-integration";
import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import { resolveEmbeddedCollectionExtensionInstallByKey } from "@artgod/shared/extensions/built-ins";
import {
    BOOTSTRAP_RUN_EVENT_CODE,
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
    BootstrapStepOrchestrator,
    readyStepResult,
    runningStepResult,
    terminalStepResult,
    type BootstrapClaimedStepProcessorResult,
} from "../application/bootstrap-step-orchestrator.js";
import {
    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME,
    BootstrapBackfillExecutor,
    type BootstrapBackfillCheckResult,
    type BootstrapBackfillQueuePort,
    type BootstrapBackfillScheduleResult,
} from "../application/bootstrap-backfill-executor.js";
import {
    cleanupSuccessfulBootstrapTemporaryData,
    type BootstrapTemporaryDataCleanupResult,
} from "../application/bootstrap-temporary-data-cleanup.js";
import {
    BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE,
    completeCollectionExtensionArtifactStepIfTerminal,
    failCollectionExtensionArtifactStep,
    updateCollectionExtensionArtifactStepProgress,
} from "../application/bootstrap-collection-extension-artifacts.js";
import {
    BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME,
    BootstrapAnchorExecutor,
    type BootstrapAnchorExecutorResult,
} from "../application/bootstrap-anchor-executor.js";
import { BootstrapEnumerationExecutor } from "../application/bootstrap-enumeration-executor.js";
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
    OPENSEA_JOB_ID_SCOPE,
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
    BootstrapSnapshotPort,
    BootstrapImageCacheTask,
    BootstrapOwnershipTask,
    BootstrapOwnershipTaskSeed,
} from "../ports/bootstrap.js";
import type {
    BootstrapRunDefinition,
    BootstrapRunsPort,
} from "../ports/bootstrap-runs.js";
import type {
    BootstrapStepRecord,
    BootstrapStepsPort,
} from "../ports/bootstrap-steps.js";
import type { CollectionRegistryPort } from "../ports/collections.js";
import type { CollectionExtensionInstallPort } from "../ports/collection-extensions.js";
import {
    METADATA_REFRESH_REASON,
    METADATA_REFRESH_SOURCE,
    type MetadataRefreshPayload,
} from "../domain/domain-jobs.js";
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
const BOOTSTRAP_EXTENSION_ARTIFACT_PUBLISH_BATCH_SIZE = 500;
const BOOTSTRAP_STARTUP_SWEEP_RUN_LIMIT = 100;
const BOOTSTRAP_STARTUP_SWEEP_TRACE_PREFIX = "bootstrap:startup-sweep";
const BOOTSTRAP_STEP_LEASE_MS = 60_000;
const BOOTSTRAP_STEP_CLAIM_LIMIT = 1;
const BOOTSTRAP_STEP_MAX_ITERATIONS = 20;
const BOOTSTRAP_MAIN_STEP_LEASE_OWNER = "bootstrap-worker:main";
const BOOTSTRAP_IMAGE_CACHE_STEP_LEASE_OWNER = "bootstrap-worker:image-cache";
const BOOTSTRAP_MAIN_LANE_STEP_KEYS = [
    BOOTSTRAP_STEP_KEY.Anchor,
    BOOTSTRAP_STEP_KEY.Enumeration,
    BOOTSTRAP_STEP_KEY.Metadata,
    BOOTSTRAP_STEP_KEY.Ownership,
    BOOTSTRAP_STEP_KEY.Backfill,
    BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
    BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
] as const;
const BOOTSTRAP_IMAGE_CACHE_LANE_STEP_KEYS = [
    BOOTSTRAP_STEP_KEY.ImageCache,
] as const;

const BOOTSTRAP_WORKER_COMPONENT = "CollectionBootstrapWorker";
const BOOTSTRAP_WORKER_ACTION = {
    Main: "main",
    Shutdown: "shutdown",
    ImageCacheLaneJob: "processBootstrapImageCacheLaneJob",
    StartupSweep: "reconcileActiveBootstrapRuns",
    StartupRun: "reconcileActiveBootstrapRun",
    StartupStepWake: "wakeBootstrapStep",
    MainStepLoop: "runBootstrapMainStepLoop",
    ImageCacheStepLoop: "runBootstrapImageCacheStepLoop",
    AnchorStep: "processBootstrapAnchorStep",
    MetadataStep: "processBootstrapMetadataStep",
    ImageCacheStep: "processBootstrapImageCacheStep",
    OwnershipStep: "processBootstrapOwnershipStep",
    BackfillStep: "processBootstrapBackfillStep",
    TemporaryDataCleanup: "cleanupBootstrapTemporaryData",
} as const;
const BOOTSTRAP_METADATA_SKIP_REASON = {
    CollectionAlreadyLive: "collection already live",
} as const;
const BOOTSTRAP_OWNERSHIP_FAILURE_CODE = {
    SnapshotFailed: "ownership_snapshot_failed",
} as const;
const BOOTSTRAP_OWNERSHIP_SKIP_REASON = {
    SnapshotAlreadyCurrent: "snapshot already current",
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
        const bootstrapEnumerationExecutor = new BootstrapEnumerationExecutor(
            {
                resolveTokenIds: async ({ run, anchorBlock, onProgress }) =>
                    resolveTokenIdsForRun(rpc, run, anchorBlock, onProgress),
            },
            bootstrapStorage,
            bootstrapRuns,
            bootstrapSteps,
            TOKEN_ENUMERATION_HEARTBEAT_MS,
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
            bootstrapRuns,
            bootstrapSteps,
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
                        await runBootstrapMainStepLoop({
                            queue,
                            collections,
                            collectionExtensions,
                            bootstrapStorage,
                            bootstrapRuns,
                            bootstrapSteps,
                            bootstrapAnchorExecutor,
                            bootstrapEnumerationExecutor,
                            bootstrapBackfillExecutor,
                            rpc,
                            metadataDomain,
                            reorgDepth: config.sync.reorgDepth,
                            backfillBatchSize: config.sync.backfillBatchSize,
                            snapshotBatchSize:
                                config.bootstrap.snapshotBatchSize,
                            metadataBatchSize:
                                config.bootstrap.metadataBatchSize,
                            metadataConcurrency:
                                config.bootstrap.metadataConcurrency,
                            metadataPollMs:
                                config.bootstrap.metadataProcessPollMs,
                            metadataRetryPolicy:
                                config.bootstrap.metadataRetryPolicy,
                            openSeaIntegration: config.integrations.opensea,
                            payload: job.payload as BootstrapCollectionPayload,
                            traceId: job.traceId ?? job.jobId,
                            sourceJobId: job.jobId,
                        });
                        return;
                    }

                    if (job.kind === BOOTSTRAP_JOB_KIND.MetadataProcess) {
                        await runBootstrapMainStepLoop({
                            queue,
                            collections,
                            collectionExtensions,
                            bootstrapStorage,
                            bootstrapRuns,
                            bootstrapSteps,
                            bootstrapAnchorExecutor,
                            bootstrapEnumerationExecutor,
                            bootstrapBackfillExecutor,
                            rpc,
                            metadataDomain,
                            reorgDepth: config.sync.reorgDepth,
                            backfillBatchSize: config.sync.backfillBatchSize,
                            snapshotBatchSize:
                                config.bootstrap.snapshotBatchSize,
                            metadataBatchSize:
                                config.bootstrap.metadataBatchSize,
                            metadataConcurrency:
                                config.bootstrap.metadataConcurrency,
                            metadataPollMs:
                                config.bootstrap.metadataProcessPollMs,
                            metadataRetryPolicy:
                                config.bootstrap.metadataRetryPolicy,
                            openSeaIntegration: config.integrations.opensea,
                            payload: job.payload as BootstrapMetadataProcessPayload,
                            traceId: job.traceId ?? job.jobId,
                            sourceJobId: job.jobId,
                        });
                        return;
                    }

                    if (job.kind === BOOTSTRAP_JOB_KIND.OwnershipProcess) {
                        await runBootstrapMainStepLoop({
                            queue,
                            collections,
                            collectionExtensions,
                            bootstrapStorage,
                            bootstrapRuns,
                            bootstrapSteps,
                            bootstrapAnchorExecutor,
                            bootstrapEnumerationExecutor,
                            bootstrapBackfillExecutor,
                            rpc,
                            metadataDomain,
                            reorgDepth: config.sync.reorgDepth,
                            backfillBatchSize: config.sync.backfillBatchSize,
                            snapshotBatchSize:
                                config.bootstrap.snapshotBatchSize,
                            metadataBatchSize:
                                config.bootstrap.metadataBatchSize,
                            metadataConcurrency:
                                config.bootstrap.metadataConcurrency,
                            metadataPollMs:
                                config.bootstrap.metadataProcessPollMs,
                            metadataRetryPolicy:
                                config.bootstrap.metadataRetryPolicy,
                            openSeaIntegration: config.integrations.opensea,
                            payload: job.payload as BootstrapOwnershipProcessPayload,
                            traceId: job.traceId ?? job.jobId,
                            sourceJobId: job.jobId,
                        });
                        return;
                    }

                    if (job.kind === BOOTSTRAP_JOB_KIND.BackfillCheck) {
                        await runBootstrapMainStepLoop({
                            queue,
                            collections,
                            collectionExtensions,
                            bootstrapStorage,
                            bootstrapRuns,
                            bootstrapSteps,
                            bootstrapAnchorExecutor,
                            bootstrapEnumerationExecutor,
                            bootstrapBackfillExecutor,
                            rpc,
                            metadataDomain,
                            reorgDepth: config.sync.reorgDepth,
                            backfillBatchSize: config.sync.backfillBatchSize,
                            snapshotBatchSize:
                                config.bootstrap.snapshotBatchSize,
                            metadataBatchSize:
                                config.bootstrap.metadataBatchSize,
                            metadataConcurrency:
                                config.bootstrap.metadataConcurrency,
                            metadataPollMs:
                                config.bootstrap.metadataProcessPollMs,
                            metadataRetryPolicy:
                                config.bootstrap.metadataRetryPolicy,
                            openSeaIntegration: config.integrations.opensea,
                            payload: job.payload as BootstrapBackfillCheckPayload,
                            traceId: job.traceId ?? job.jobId,
                            sourceJobId: job.jobId,
                        });
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
                            component: BOOTSTRAP_WORKER_COMPONENT,
                            action: BOOTSTRAP_WORKER_ACTION.ImageCacheLaneJob,
                            jobKind: job.kind,
                            jobId: job.jobId,
                        });
                        return;
                    }
                    await runBootstrapImageCacheStepLoop({
                        queue,
                        collections,
                        bootstrapStorage,
                        bootstrapRuns,
                        bootstrapSteps,
                        tokenImageCache,
                        imageCacheBatchSize:
                            config.bootstrap.imageCacheBatchSize,
                        imageCacheConcurrency:
                            config.bootstrap.imageCacheConcurrency,
                        imageCacheRetryPolicy:
                            config.bootstrap.metadataRetryPolicy,
                        payload: job.payload,
                        traceId: job.traceId ?? job.jobId,
                    });
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
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.Main,
            rpcEndpoint: summarizeRpcUrl(config.rpc.endpoints[0]?.url ?? ""),
            rpcRateLimitRps:
                config.rpc.resilience.rateLimiter.requestsPerSecond,
            rpcRateLimitBurst: config.rpc.resilience.rateLimiter.burst,
        });

        const shutdown = async () => {
            logger.info("Collection bootstrap worker shutting down", {
                component: BOOTSTRAP_WORKER_COMPONENT,
                action: BOOTSTRAP_WORKER_ACTION.Shutdown,
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
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.Main,
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
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
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
    run: BootstrapRunDefinition,
    stepKey: BootstrapStepKey,
    traceId: string,
): Promise<void> {
    if (
        (BOOTSTRAP_MAIN_LANE_STEP_KEYS as readonly BootstrapStepKey[]).includes(
            stepKey,
        )
    ) {
        await scheduleBootstrapStart(
            queue,
            buildBootstrapCollectionPayload(run),
            traceId,
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
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.AnchorStep,
            runId: result.run.runId,
            chainId: result.run.chainId,
            collectionId: result.run.collectionId,
            standard: result.run.requestStandard,
        });
        return;
    }

    if (result.outcome === BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.InvalidAnchor) {
        logger.warn("Bootstrap skipped (invalid anchor block)", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.AnchorStep,
            runId: result.run.runId,
            chainId: result.run.chainId,
            collectionId: result.run.collectionId,
        });
        return;
    }

    if (result.outcome === BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.CollectionMissing) {
        logger.warn("Bootstrap skipped (collection missing)", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.AnchorStep,
            runId: result.run.runId,
            chainId: result.run.chainId,
            collectionId: result.run.collectionId,
            anchorBlock: result.anchor?.anchorBlock,
        });
    }
}

type BootstrapMainStepLoopPayload =
    | BootstrapCollectionPayload
    | BootstrapMetadataProcessPayload
    | BootstrapOwnershipProcessPayload
    | BootstrapBackfillCheckPayload;

type BootstrapMainStepLoopInput = {
    queue: QueuePort;
    collections: CollectionRegistryPort;
    collectionExtensions: CollectionExtensionInstallPort;
    bootstrapStorage: BootstrapSnapshotPort;
    bootstrapRuns: BootstrapRunsPort;
    bootstrapSteps: BootstrapStepsPort;
    bootstrapAnchorExecutor: BootstrapAnchorExecutor;
    bootstrapEnumerationExecutor: BootstrapEnumerationExecutor;
    bootstrapBackfillExecutor: BootstrapBackfillExecutor;
    rpc: RpcProviderPort;
    metadataDomain: SqliteMetadataDomain;
    reorgDepth: number;
    backfillBatchSize: number;
    snapshotBatchSize: number;
    metadataBatchSize: number;
    metadataConcurrency: number;
    metadataPollMs: number;
    metadataRetryPolicy: RetryPolicy;
    openSeaIntegration: OpenSeaIntegrationStatus;
    payload: BootstrapMainStepLoopPayload;
    traceId: string;
    sourceJobId: string;
};

type BootstrapImageCacheStepLoopInput = {
    queue: QueuePort;
    collections: CollectionRegistryPort;
    bootstrapStorage: BootstrapSnapshotPort;
    bootstrapRuns: BootstrapRunsPort;
    bootstrapSteps: BootstrapStepsPort;
    tokenImageCache: TokenImageCachePort;
    imageCacheBatchSize: number;
    imageCacheConcurrency: number;
    imageCacheRetryPolicy: RetryPolicy;
    payload: BootstrapImageCacheProcessPayload;
    traceId: string;
};

async function runBootstrapMainStepLoop(
    input: BootstrapMainStepLoopInput,
): Promise<void> {
    const leaseOwner = buildBootstrapStepLeaseOwner(
        BOOTSTRAP_MAIN_STEP_LEASE_OWNER,
    );
    const orchestrator = new BootstrapStepOrchestrator(
        input.bootstrapRuns,
        input.bootstrapSteps,
        {
            processClaimedStep: async ({ run, step, traceId }) =>
                processBootstrapMainClaimedStep({
                    ...input,
                    run,
                    step,
                    leaseOwner,
                    traceId,
                }),
        },
        {
            wakeBootstrapStep: async ({ run, stepKey, traceId }) => {
                await wakeBootstrapStep(input.queue, run, stepKey, traceId);
            },
        },
    );
    const result = await orchestrator.run({
        runId: input.payload.runId,
        traceId: input.traceId,
        laneStepKeys: BOOTSTRAP_MAIN_LANE_STEP_KEYS,
        leaseOwner,
        leaseMs: BOOTSTRAP_STEP_LEASE_MS,
        claimLimit: BOOTSTRAP_STEP_CLAIM_LIMIT,
        maxIterations: BOOTSTRAP_STEP_MAX_ITERATIONS,
    });
    logger.debug("Bootstrap main step loop completed", {
        component: BOOTSTRAP_WORKER_COMPONENT,
        action: BOOTSTRAP_WORKER_ACTION.MainStepLoop,
        runId: result.runId,
        claimedStepKeys: result.claimedStepKeys,
        readyStepKeys: result.readyStepKeys,
        wakeStepKeys: result.wakeStepKeys,
    });
}

async function runBootstrapImageCacheStepLoop(
    input: BootstrapImageCacheStepLoopInput,
): Promise<void> {
    const leaseOwner = buildBootstrapStepLeaseOwner(
        BOOTSTRAP_IMAGE_CACHE_STEP_LEASE_OWNER,
    );
    const orchestrator = new BootstrapStepOrchestrator(
        input.bootstrapRuns,
        input.bootstrapSteps,
        {
            processClaimedStep: async ({ run, step, traceId }) =>
                processBootstrapImageCacheClaimedStep({
                    ...input,
                    run,
                    step,
                    leaseOwner,
                    traceId,
                }),
        },
        {
            wakeBootstrapStep: async ({ run, stepKey, traceId }) => {
                await wakeBootstrapStep(input.queue, run, stepKey, traceId);
            },
        },
    );
    const result = await orchestrator.run({
        runId: input.payload.runId,
        traceId: input.traceId,
        laneStepKeys: BOOTSTRAP_IMAGE_CACHE_LANE_STEP_KEYS,
        leaseOwner,
        leaseMs: BOOTSTRAP_STEP_LEASE_MS,
        claimLimit: BOOTSTRAP_STEP_CLAIM_LIMIT,
        maxIterations: BOOTSTRAP_STEP_MAX_ITERATIONS,
    });
    logger.debug("Bootstrap image-cache step loop completed", {
        component: BOOTSTRAP_WORKER_COMPONENT,
        action: BOOTSTRAP_WORKER_ACTION.ImageCacheStepLoop,
        runId: result.runId,
        claimedStepKeys: result.claimedStepKeys,
        readyStepKeys: result.readyStepKeys,
        wakeStepKeys: result.wakeStepKeys,
    });
}

function buildBootstrapStepLeaseOwner(scope: string): string {
    const nonce = Math.floor(Math.random() * 1_000_000_000);
    return `${scope}:${process.pid}:${Date.now()}:${nonce}`;
}

async function processBootstrapMainClaimedStep(
    input: BootstrapMainStepLoopInput & {
        run: BootstrapRunDefinition;
        step: BootstrapStepRecord;
        leaseOwner: string;
    },
): Promise<BootstrapClaimedStepProcessorResult> {
    if (input.step.stepKey === BOOTSTRAP_STEP_KEY.Anchor) {
        const result = await input.bootstrapAnchorExecutor.anchor({
            run: input.run,
            reorgDepth: input.reorgDepth,
        });
        logBootstrapAnchorResult(result);
        if (result.outcome === BOOTSTRAP_ANCHOR_EXECUTOR_OUTCOME.Anchored) {
            ensureRequestedCollectionExtensionInstalled(
                input.collectionExtensions,
                input.run.chainId,
                input.run.collectionId,
                input.run.requestExtensionKey,
            );
        }
        return terminalStepResult();
    }

    if (input.step.stepKey === BOOTSTRAP_STEP_KEY.Enumeration) {
        const anchoredRun = getAnchoredBootstrapRun(input.run);
        if (!anchoredRun) {
            logMissingAnchorForWake(input.run, input.step.stepKey);
            return readyStepResult(Date.now() + BOOTSTRAP_BACKFILL_CHECK_DELAY_MS);
        }
        await input.bootstrapEnumerationExecutor.execute({
            run: input.run,
            anchor: {
                anchorBlock: anchoredRun.anchorBlock,
                anchorHash: anchoredRun.anchorBlockHash as Hex,
                anchorTimestamp: anchoredRun.anchorBlockTimestamp,
            },
            metadataBatchSize: input.metadataBatchSize,
            traceId: input.traceId,
        });
        return terminalStepResult();
    }

    if (input.step.stepKey === BOOTSTRAP_STEP_KEY.Metadata) {
        const anchoredRun = getAnchoredBootstrapRun(input.run);
        if (!anchoredRun) {
            logMissingAnchorForWake(input.run, input.step.stepKey);
            return readyStepResult(Date.now() + BOOTSTRAP_BACKFILL_CHECK_DELAY_MS);
        }
        return processBootstrapMetadataStep({
            collections: input.collections,
            bootstrapStorage: input.bootstrapStorage,
            bootstrapRuns: input.bootstrapRuns,
            bootstrapSteps: input.bootstrapSteps,
            metadataDomain: input.metadataDomain,
            metadataBatchSize: input.metadataBatchSize,
            metadataConcurrency: input.metadataConcurrency,
            metadataPollMs: input.metadataPollMs,
            metadataRetryPolicy: input.metadataRetryPolicy,
            payload: buildMetadataProcessPayload(anchoredRun),
        });
    }

    if (input.step.stepKey === BOOTSTRAP_STEP_KEY.Ownership) {
        const anchoredRun = getAnchoredBootstrapRun(input.run);
        if (!anchoredRun) {
            logMissingAnchorForWake(input.run, input.step.stepKey);
            return readyStepResult(Date.now() + BOOTSTRAP_BACKFILL_CHECK_DELAY_MS);
        }
        return processBootstrapOwnershipStep({
            rpc: input.rpc,
            collections: input.collections,
            bootstrapStorage: input.bootstrapStorage,
            bootstrapRuns: input.bootstrapRuns,
            bootstrapSteps: input.bootstrapSteps,
            ownershipBatchSize: input.snapshotBatchSize,
            ownershipRetryPolicy: input.metadataRetryPolicy,
            payload: buildOwnershipProcessPayload(anchoredRun),
        });
    }

    if (input.step.stepKey === BOOTSTRAP_STEP_KEY.Backfill) {
        const anchoredRun = getAnchoredBootstrapRun(input.run);
        if (!anchoredRun) {
            logMissingAnchorForWake(input.run, input.step.stepKey);
            return readyStepResult(Date.now() + BOOTSTRAP_BACKFILL_CHECK_DELAY_MS);
        }
        return processBootstrapBackfillStep({
            backfillExecutor: input.bootstrapBackfillExecutor,
            payload: buildOwnershipProcessPayload(anchoredRun),
            backfillCheckPayload: isBootstrapBackfillCheckPayload(input.payload)
                ? input.payload
                : null,
            backfillBatchSize: input.backfillBatchSize,
            openSeaIntegration: input.openSeaIntegration,
            traceId: input.traceId,
            sourceJobId: input.sourceJobId,
        });
    }

    if (input.step.stepKey === BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts) {
        await scheduleCollectionExtensionArtifactsSideLaneIfNeeded(
            input.queue,
            input.collectionExtensions,
            input.bootstrapStorage,
            input.bootstrapRuns,
            input.bootstrapSteps,
            input.run,
            input.traceId,
        );
        const step = input.bootstrapSteps.getStep(
            input.run.runId,
            BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
        );
        return step && isBootstrapStepTerminalStatus(step.status)
            ? terminalStepResult()
            : runningStepResult(null);
    }

    if (input.step.stepKey === BOOTSTRAP_STEP_KEY.OpenSeaIdentity) {
        await scheduleOpenSeaBootstrap(input.queue, {
            chainId: input.run.chainId,
            collectionId: input.run.collectionId,
            bootstrap: {
                runId: input.run.runId,
            },
        });
        return runningStepResult(null);
    }

    return terminalStepResult();
}

async function processBootstrapImageCacheClaimedStep(
    input: BootstrapImageCacheStepLoopInput & {
        run: BootstrapRunDefinition;
        step: BootstrapStepRecord;
        leaseOwner: string;
    },
): Promise<BootstrapClaimedStepProcessorResult> {
    if (input.step.stepKey !== BOOTSTRAP_STEP_KEY.ImageCache) {
        return terminalStepResult();
    }
    return processBootstrapImageCacheStep(input);
}

function isBootstrapBackfillCheckPayload(
    payload: BootstrapMainStepLoopPayload,
): payload is BootstrapBackfillCheckPayload {
    return "fromBlock" in payload && "toBlock" in payload;
}

async function processBootstrapMetadataStep(input: {
    collections: CollectionRegistryPort,
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    metadataDomain: SqliteMetadataDomain,
    metadataBatchSize: number,
    metadataConcurrency: number,
    metadataPollMs: number,
    metadataRetryPolicy: RetryPolicy,
    payload: BootstrapMetadataProcessPayload;
}): Promise<BootstrapClaimedStepProcessorResult> {
    const {
        collections,
        bootstrapStorage,
        bootstrapRuns,
        bootstrapSteps,
        metadataDomain,
        metadataBatchSize,
        metadataConcurrency,
        metadataPollMs,
        metadataRetryPolicy,
        payload,
    } = input;
    if (payload.standard !== COLLECTION_STANDARD.Erc721) {
        logger.warn("Metadata process skipped (unsupported standard)", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.MetadataStep,
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            standard: payload.standard,
        });
        return readyStepResult(Date.now() + Math.max(1, metadataPollMs));
    }

    const collection = collections.getCollection(
        payload.chainId,
        payload.collectionId,
    );
    if (!collection) {
        logger.warn("Metadata process skipped (collection missing)", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.MetadataStep,
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return readyStepResult(Date.now() + Math.max(1, metadataPollMs));
    }

    if (collection.status === "live") {
        logger.debug("Metadata process skipped (collection already live)", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.MetadataStep,
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        bootstrapSteps.markStepSkipped(
            payload.runId,
            BOOTSTRAP_STEP_KEY.Metadata,
            BOOTSTRAP_METADATA_SKIP_REASON.CollectionAlreadyLive,
        );
        return terminalStepResult();
    }

    const processed = await processDueMetadataTasks(
        bootstrapStorage,
        metadataDomain,
        payload,
        metadataBatchSize,
        metadataConcurrency,
        metadataRetryPolicy,
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

        const nextDelayMs = hasDueNow ? 0 : Math.max(1, metadataPollMs);

        logger.debug("Bootstrap metadata process progress", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.MetadataStep,
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            mode: payload.metadataSnapshotMode,
            processed,
            counts,
            nextDelayMs,
        });
        return readyStepResult(Date.now() + nextDelayMs);
    }

    const run = bootstrapRuns.getRun(payload.runId);
    if (!run) {
        logger.warn("Image cache skipped (run missing)", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.MetadataStep,
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return readyStepResult(Date.now() + Math.max(1, metadataPollMs));
    }

    bootstrapSteps.markStepSucceeded(run.runId, BOOTSTRAP_STEP_KEY.Metadata, {
        completed: counts.total,
        total: counts.total,
    });
    return terminalStepResult();
}

async function scheduleCollectionExtensionArtifactsSideLaneIfNeeded(
    queue: QueuePort,
    collectionExtensions: CollectionExtensionInstallPort,
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    run: BootstrapRunDefinition,
    traceId: string,
): Promise<void> {
    if (!run.requestExtensionKey) {
        return;
    }

    const install = collectionExtensions.getInstall(
        run.chainId,
        run.collectionId,
    );
    if (!install?.enabled) {
        failCollectionExtensionArtifactStep({
            runsPort: bootstrapRuns,
            stepsPort: bootstrapSteps,
            run,
            error: BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE.InstallMissing,
        });
        return;
    }

    const existingCounts =
        bootstrapStorage.getCollectionExtensionArtifactTaskCounts(run.runId);
    if (existingCounts.total <= 0) {
        const seeded = bootstrapStorage.seedCollectionExtensionArtifactTasks({
            runId: run.runId,
            extensionKey: install.extensionKey,
        });
        const seededCounts =
            bootstrapStorage.getCollectionExtensionArtifactTaskCounts(run.runId);
        if (
            completeCollectionExtensionArtifactStepIfTerminal({
                runsPort: bootstrapRuns,
                stepsPort: bootstrapSteps,
                run,
                counts: seededCounts,
            })
        ) {
            return;
        }
        bootstrapRuns.appendRunEvent({
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            eventCode:
                BOOTSTRAP_RUN_EVENT_CODE.CollectionExtensionArtifactsQueued,
            eventLevel: "info",
            message: "Bootstrap collection-extension artifacts side lane queued",
            payloadJson: JSON.stringify({
                seeded,
                total: seededCounts.total,
                extensionKey: install.extensionKey,
            }),
        });
    }

    const counts =
        bootstrapStorage.getCollectionExtensionArtifactTaskCounts(run.runId);
    if (
        completeCollectionExtensionArtifactStepIfTerminal({
            runsPort: bootstrapRuns,
            stepsPort: bootstrapSteps,
            run,
            counts,
        })
    ) {
        return;
    }
    updateCollectionExtensionArtifactStepProgress({
        stepsPort: bootstrapSteps,
        runId: run.runId,
        counts,
    });
    bootstrapSteps.markStepRunning(
        run.runId,
        BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
    );
    await publishCollectionExtensionArtifactTaskJobs(
        queue,
        bootstrapStorage,
        run.runId,
        traceId,
    );
}

async function publishCollectionExtensionArtifactTaskJobs(
    queue: QueuePort,
    bootstrapStorage: BootstrapSnapshotPort,
    runId: number,
    traceId: string,
): Promise<number> {
    let cursorTokenId: string | null = null;
    let published = 0;
    for (;;) {
        const tasks =
            bootstrapStorage.listCollectionExtensionArtifactTasksToPublish(
                runId,
                cursorTokenId,
                BOOTSTRAP_EXTENSION_ARTIFACT_PUBLISH_BATCH_SIZE,
            );
        if (tasks.length === 0) {
            return published;
        }

        for (const task of tasks) {
            cursorTokenId = task.tokenId;
            published += 1;
            await publishCollectionExtensionRefreshArtifacts(
                queue,
                {
                    chainId: task.chainId,
                    collectionId: task.collectionId,
                    contract: task.contract,
                    tokenId: task.tokenId,
                    reason: METADATA_REFRESH_REASON.BootstrapSnapshot,
                    source: METADATA_REFRESH_SOURCE.Bootstrap,
                    bootstrap: {
                        runId: task.runId,
                        extensionKey: task.extensionKey,
                    },
                },
                traceId,
                {
                    attempt: task.attempts,
                    delayMs: Math.max(0, task.nextAttemptAt - Date.now()),
                },
            );
        }

        if (
            tasks.length < BOOTSTRAP_EXTENSION_ARTIFACT_PUBLISH_BATCH_SIZE ||
            cursorTokenId === null
        ) {
            return published;
        }
    }
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
    payload: BootstrapMetadataProcessPayload,
    metadataBatchSize: number,
    metadataConcurrency: number,
    metadataRetryPolicy: RetryPolicy,
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
                payload,
                task,
                metadataRetryPolicy,
            );
        },
    );

    return dueTasks.length;
}

async function processBootstrapImageCacheStep(input: {
    collections: CollectionRegistryPort,
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    tokenImageCache: TokenImageCachePort,
    imageCacheBatchSize: number,
    imageCacheConcurrency: number,
    imageCacheRetryPolicy: RetryPolicy,
    payload: BootstrapImageCacheProcessPayload;
}): Promise<BootstrapClaimedStepProcessorResult> {
    const {
        collections,
        bootstrapStorage,
        bootstrapRuns,
        bootstrapSteps,
        tokenImageCache,
        imageCacheBatchSize,
        imageCacheConcurrency,
        imageCacheRetryPolicy,
        payload,
    } = input;
    const collection = collections.getCollection(
        payload.chainId,
        payload.collectionId,
    );
    if (!collection) {
        logger.warn("Image cache process skipped (collection missing)", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.ImageCacheStep,
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return readyStepResult(Date.now() + BOOTSTRAP_BACKFILL_CHECK_DELAY_MS);
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
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.ImageCacheStep,
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            stepStatus: imageCacheStep.status,
        });
        return terminalStepResult();
    }

    const run = bootstrapRuns.getRun(payload.runId);
    if (!run) {
        logger.warn("Image cache process skipped (run missing)", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.ImageCacheStep,
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return readyStepResult(Date.now() + BOOTSTRAP_BACKFILL_CHECK_DELAY_MS);
    }
    if (
        !ensureImageCacheTasksSeeded(
            bootstrapStorage,
            bootstrapRuns,
            bootstrapSteps,
            run,
        )
    ) {
        return terminalStepResult();
    }

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
        const nextDelayMs = hasDueNow ? 0 : BOOTSTRAP_BACKFILL_CHECK_DELAY_MS;

        logger.debug("Bootstrap image cache process progress", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.ImageCacheStep,
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            processed,
            counts,
            nextDelayMs,
        });
        return readyStepResult(Date.now() + nextDelayMs);
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
    return terminalStepResult();
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
    payload: BootstrapMetadataProcessPayload,
    task: BootstrapMetadataTask,
    metadataRetryPolicy: RetryPolicy,
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
            reason: METADATA_REFRESH_REASON.BootstrapSnapshot,
            source: METADATA_REFRESH_SOURCE.Bootstrap,
        };
        const updated =
            await metadataDomain.handleMetadataRefresh(refreshPayload);
        if (updated) {
            bootstrapStorage.markMetadataTaskSucceeded(
                task.runId,
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

async function processBootstrapOwnershipStep(input: {
    rpc: RpcProviderPort,
    collections: CollectionRegistryPort,
    bootstrapStorage: BootstrapSnapshotPort,
    bootstrapRuns: BootstrapRunsPort,
    bootstrapSteps: BootstrapStepsPort,
    ownershipBatchSize: number,
    ownershipRetryPolicy: RetryPolicy,
    payload: BootstrapOwnershipProcessPayload;
}): Promise<BootstrapClaimedStepProcessorResult> {
    const {
        rpc,
        collections,
        bootstrapStorage,
        bootstrapRuns,
        bootstrapSteps,
        ownershipBatchSize,
        ownershipRetryPolicy,
        payload,
    } = input;
    const collection = collections.getCollection(
        payload.chainId,
        payload.collectionId,
    );
    if (!collection) {
        logger.warn("Ownership process skipped (collection missing)", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.OwnershipStep,
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
        });
        return readyStepResult(Date.now() + BOOTSTRAP_BACKFILL_CHECK_DELAY_MS);
    }

    const ownershipStep = bootstrapSteps.getStep(
        payload.runId,
        BOOTSTRAP_STEP_KEY.Ownership,
    );
    if (ownershipStep && isBootstrapStepTerminalStatus(ownershipStep.status)) {
        logger.debug("Ownership process skipped (step already terminal)", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.OwnershipStep,
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            stepStatus: ownershipStep.status,
        });
        return terminalStepResult();
    }

    if (
        collection.bootstrapLastSyncedBlock !== null &&
        collection.bootstrapLastSyncedBlock >= payload.anchorBlock
    ) {
        bootstrapSteps.markStepSkipped(
            payload.runId,
            BOOTSTRAP_STEP_KEY.Ownership,
            BOOTSTRAP_OWNERSHIP_SKIP_REASON.SnapshotAlreadyCurrent,
        );
        return terminalStepResult();
    }

    const seededOwnershipCounts = ensureOwnershipTasksSeeded(
        bootstrapStorage,
        payload,
        ownershipBatchSize,
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
        const nextDelayMs = hasDueNow ? 0 : BOOTSTRAP_BACKFILL_CHECK_DELAY_MS;
        logger.debug("Bootstrap ownership process progress", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.OwnershipStep,
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            processed,
            counts,
            nextDelayMs,
        });
        return readyStepResult(Date.now() + nextDelayMs);
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
            code: BOOTSTRAP_OWNERSHIP_FAILURE_CODE.SnapshotFailed,
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
        return terminalStepResult();
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
        component: BOOTSTRAP_WORKER_COMPONENT,
        action: BOOTSTRAP_WORKER_ACTION.OwnershipStep,
        runId: payload.runId,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        anchorBlock: payload.anchorBlock,
        tokenCount: counts.total,
    });

    return terminalStepResult();
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

async function processBootstrapBackfillStep(input: {
    backfillExecutor: BootstrapBackfillExecutor;
    payload: BootstrapOwnershipProcessPayload;
    backfillCheckPayload: BootstrapBackfillCheckPayload | null;
    backfillBatchSize: number;
    openSeaIntegration: OpenSeaIntegrationStatus;
    traceId: string;
    sourceJobId: string;
}): Promise<BootstrapClaimedStepProcessorResult> {
    if (input.backfillCheckPayload) {
        const result = await input.backfillExecutor.checkProgress({
            chainId: input.backfillCheckPayload.chainId,
            runId: input.backfillCheckPayload.runId,
            collectionId: input.backfillCheckPayload.collectionId,
            address: input.backfillCheckPayload.address,
            fromBlock: input.backfillCheckPayload.fromBlock,
            toBlock: input.backfillCheckPayload.toBlock,
            traceId: input.traceId,
            sourceJobId: input.sourceJobId,
        });
        logBootstrapBackfillCheckResult(result, input.backfillCheckPayload);
        logBootstrapTemporaryDataCleanup(result.cleanup);
        if (
            result.outcome ===
            BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete
        ) {
            return readyStepResult(
                Date.now() + BOOTSTRAP_BACKFILL_CHECK_DELAY_MS,
            );
        }
        return terminalStepResult();
    }

    const result = await input.backfillExecutor.scheduleAfterSnapshot({
        chainId: input.payload.chainId,
        runId: input.payload.runId,
        collectionId: input.payload.collectionId,
        address: input.payload.address,
        anchorBlock: input.payload.anchorBlock,
        backfillBatchSize: input.backfillBatchSize,
        openSeaIntegration: input.openSeaIntegration,
        traceId: input.traceId,
        sourceJobId: input.sourceJobId,
    });
    logBootstrapBackfillScheduleResult(result, input.payload);
    logBootstrapTemporaryDataCleanup(result.cleanup);
    if (
        result.outcome === BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillQueued
    ) {
        return readyStepResult(Date.now() + BOOTSTRAP_BACKFILL_CHECK_DELAY_MS);
    }
    return terminalStepResult();
}

function logBootstrapBackfillScheduleResult(
    result: BootstrapBackfillScheduleResult,
    payload: BootstrapMetadataProcessPayload | BootstrapOwnershipProcessPayload,
): void {
    if (result.outcome === BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.InvalidRange) {
        logger.warn("Bootstrap backfill skipped (invalid range)", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.BackfillStep,
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
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.BackfillStep,
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
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.BackfillStep,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            anchorBlock: payload.anchorBlock,
            head: result.headBlock,
        });
        return;
    }

    logger.info("Bootstrap backfill queued", {
        component: BOOTSTRAP_WORKER_COMPONENT,
        action: BOOTSTRAP_WORKER_ACTION.BackfillStep,
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        fromBlock: result.plan?.fromBlock,
        toBlock:
            result.plan && "toBlock" in result.plan
                ? result.plan.toBlock
                : undefined,
    });
}

function logBootstrapBackfillCheckResult(
    result: BootstrapBackfillCheckResult,
    payload: BootstrapBackfillCheckPayload,
): void {
    if (result.outcome === BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.InvalidRange) {
        logger.warn("Bootstrap backfill check skipped (invalid range)", {
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.BackfillStep,
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
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.BackfillStep,
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
            component: BOOTSTRAP_WORKER_COMPONENT,
            action: BOOTSTRAP_WORKER_ACTION.BackfillStep,
            runId: payload.runId,
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            fromBlock: payload.fromBlock,
            toBlock: payload.toBlock,
        });
        return;
    }

    logger.info("Bootstrap backfill complete; collection live", {
        component: BOOTSTRAP_WORKER_COMPONENT,
        action: BOOTSTRAP_WORKER_ACTION.BackfillStep,
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
        component: BOOTSTRAP_WORKER_COMPONENT,
        action: BOOTSTRAP_WORKER_ACTION.TemporaryDataCleanup,
        runId: cleanup.run.runId,
        chainId: cleanup.run.chainId,
        collectionId: cleanup.run.collectionId,
        metadataTasks: cleanup.metadataTasks,
        imageCacheTasks: cleanup.imageCacheTasks,
        ownershipTasks: cleanup.ownershipTasks,
        ownershipSnapshotRows: cleanup.ownershipSnapshotRows,
        collectionExtensionArtifactTasks:
            cleanup.collectionExtensionArtifactTasks,
    });
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
        jobId: [
            OPENSEA_JOB_ID_SCOPE.BootstrapCollection,
            payload.chainId,
            payload.bootstrap?.runId ?? payload.collectionId,
            payload.collectionId,
        ].join(":"),
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
