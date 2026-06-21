import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { isBootstrapTaskTerminalStatus } from "@artgod/shared/bootstrap/pipeline";
import { loadConfig } from "../config/index.js";
import {
    BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE,
    completeCollectionExtensionArtifactStepIfTerminal,
    updateCollectionExtensionArtifactStepProgress,
} from "../application/bootstrap-collection-extension-artifacts.js";
import {
    cleanupSuccessfulBootstrapTemporaryData,
    type BootstrapTemporaryDataCleanupResult,
} from "../application/bootstrap-temporary-data-cleanup.js";
import { buildBootstrapFinalStatsFollowupRun } from "../application/metadata/refresh-followups.js";
import {
    COLLECTION_EXTENSION_REFRESH_ARTIFACTS_RESULT_STATUS,
    handleCollectionExtensionRefreshArtifactsJob,
    type CollectionExtensionRefreshArtifactsResult,
} from "../application/collection-extensions/refresh-artifacts-worker.js";
import { runWorker } from "../application/worker-runner.js";
import { publishCollectionExtensionRefreshArtifacts } from "../application/collection-extensions/jobs.js";
import {
    COLLECTION_EXTENSION_JOB_KIND,
    type CollectionExtensionRefreshArtifactsPayload,
} from "../domain/collection-extension-jobs.js";
import { METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS } from "../domain/metadata-refresh-followups.js";
import { METADATA_STATS_RECOMPUTE_REASON } from "../domain/domain-jobs.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { getRetryDelayMs, type RetryPolicy } from "../domain/retry.js";
import { SqliteBootstrapRuns } from "../infra/bootstrap/sqlite-runs.js";
import { SqliteBootstrapSteps } from "../infra/bootstrap/sqlite-steps.js";
import { SqliteBootstrapStorage } from "../infra/bootstrap/sqlite.js";
import { SqliteCollectionExtensions } from "../infra/collection-extensions/sqlite.js";
import { HttpMetadataFetcher } from "../infra/metadata/http-fetcher.js";
import { SqliteMetadataRefreshFollowups } from "../infra/metadata/sqlite-refresh-followups.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
import { SqliteQueueOutbox } from "../infra/queue/sqlite-queue-outbox.js";
import { ViemRpcProvider } from "../infra/rpc/viem.js";
import {
    INDEXER_RPC_ENDPOINT_ID_PREFIX,
    INDEXER_RPC_OBSERVABILITY_COMPONENT,
} from "../infra/rpc/observability.js";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import { initRuntimeApm } from "@artgod/shared/observability/apm";
import type { BootstrapSnapshotPort } from "../ports/bootstrap.js";
import type { BootstrapRunsPort } from "../ports/bootstrap-runs.js";
import type { BootstrapStepsPort } from "../ports/bootstrap-steps.js";

const COLLECTION_EXTENSION_ARTIFACT_MAX_ATTEMPTS = 5;

async function main() {
    try {
        const config = loadConfig();
        setDbPath(config.dbPath);
        const runtimeApm = await initRuntimeApm({
            enabled: config.apm.enabled,
            serviceNamespace: config.apm.serviceNamespace,
            spanProfiles: config.apm.spanProfiles,
            worker: "collection-extension-worker",
            chainId: config.chainId,
            traces: config.apm.traces,
            profiles: config.apm.profiles,
        });
        const runtimeMetrics = await initRuntimeMetrics({
            enabled: config.metrics.enabled,
            host: config.metrics.host,
            port: config.metrics.ports.collectionExtensionWorker,
            worker: "collection-extension-worker",
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
            component:
                INDEXER_RPC_OBSERVABILITY_COMPONENT.CollectionExtensionHttp,
            endpointIdPrefix:
                INDEXER_RPC_ENDPOINT_ID_PREFIX.CollectionExtensionHttp,
            retryPolicy: config.rpc.retryPolicy,
            resilience: config.rpc.resilience,
        });
        const collectionExtensions = new SqliteCollectionExtensions();
        const queueOutbox = new SqliteQueueOutbox();
        const metadataRefreshFollowups = new SqliteMetadataRefreshFollowups(
            queueOutbox,
        );
        const bootstrapStorage = new SqliteBootstrapStorage();
        const bootstrapRuns = new SqliteBootstrapRuns();
        const bootstrapSteps = new SqliteBootstrapSteps();
        const metadataFetcher = new HttpMetadataFetcher({
            fetchResilience: config.httpFetch,
            metrics: runtimeMetrics.metrics,
        });

        const stopWorker = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.CollectionExtensionArtifacts,
                consumerName: `collection-extension-artifacts-${config.chainId}`,
                maxInFlight: 1,
                maxAttempts: COLLECTION_EXTENSION_ARTIFACT_MAX_ATTEMPTS,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
            },
            async (
                job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>,
            ) => {
                if (
                    job.kind !== COLLECTION_EXTENSION_JOB_KIND.RefreshArtifacts
                ) {
                    return;
                }

                await handleRefreshArtifactsJob({
                    queue,
                    collectionExtensions,
                    metadataRefreshFollowups,
                    bootstrapStorage,
                    bootstrapRuns,
                    bootstrapSteps,
                    rpc,
                    metadataFetcher,
                    retryPolicy: config.bootstrap.metadataRetryPolicy,
                    job,
                });
            },
            {
                apm: runtimeApm.apm,
                spanName: "worker.collectionExtension.consume",
            },
        );

        logger.info("Collection extension worker ready", {
            component: "CollectionExtensionWorker",
            action: "main",
        });

        const shutdown = async () => {
            logger.info("Collection extension worker shutting down", {
                component: "CollectionExtensionWorker",
                action: "shutdown",
            });
            await stopWorker();
            await runtimeApm.stop();
            await runtimeMetrics.stop();
            await queue.close();
            process.exit(0);
        };

        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
    } catch (error) {
        logger.error("Collection extension worker startup failed", {
            component: "CollectionExtensionWorker",
            action: "main",
            error: String(error),
        });
        process.exit(1);
    }
}

main();

async function handleRefreshArtifactsJob(input: {
    queue: NatsJetStreamQueue;
    collectionExtensions: SqliteCollectionExtensions;
    metadataRefreshFollowups: SqliteMetadataRefreshFollowups;
    bootstrapStorage: BootstrapSnapshotPort;
    bootstrapRuns: BootstrapRunsPort;
    bootstrapSteps: BootstrapStepsPort;
    rpc: ViemRpcProvider;
    metadataFetcher: HttpMetadataFetcher;
    retryPolicy: RetryPolicy;
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
}): Promise<void> {
    const job = input.job;
    if (isBootstrapArtifactTaskAlreadyTerminal(input)) {
        finalizeBootstrapArtifactTaskProgress(input);
        return;
    }

    try {
        const result = await refreshArtifacts(input);
        markMetadataRefreshArtifactTaskTerminal(input, result);
        markBootstrapArtifactTaskSucceeded(input);
    } catch (error) {
        if (
            job.payload.metadataRefreshRunId &&
            isFinalCollectionExtensionArtifactAttempt(job)
        ) {
            markMetadataRefreshArtifactTaskFailed(input);
        }
        if (!job.payload.bootstrap) {
            throw error;
        }
        const message = String(error);
        await markBootstrapArtifactTaskFailed(input, message, {
            forceTerminal: isDeterministicBootstrapArtifactFailure(message),
        });
    }
}

function isBootstrapArtifactTaskAlreadyTerminal(input: {
    bootstrapStorage: BootstrapSnapshotPort;
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
}): boolean {
    const bootstrap = input.job.payload.bootstrap;
    if (!bootstrap) {
        return false;
    }
    const task = input.bootstrapStorage.getCollectionExtensionArtifactTask({
        runId: bootstrap.runId,
        tokenId: input.job.payload.tokenId,
        extensionKey: bootstrap.extensionKey,
    });
    return task ? isBootstrapTaskTerminalStatus(task.status) : true;
}

async function refreshArtifacts(input: {
    queue: NatsJetStreamQueue;
    collectionExtensions: SqliteCollectionExtensions;
    rpc: ViemRpcProvider;
    metadataFetcher: HttpMetadataFetcher;
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
}): Promise<CollectionExtensionRefreshArtifactsResult> {
    const job = input.job;
    const bootstrapFailureOptions = job.payload.bootstrap
        ? {
              installMissingError:
                  BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE.InstallMissing,
              implementationMissingError:
                  BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE.ImplementationMissing,
          }
        : undefined;

    // Delegate extension refresh while preserving bootstrap task failure semantics.
    return handleCollectionExtensionRefreshArtifactsJob(
        job,
        input.queue,
        input.rpc,
        input.metadataFetcher,
        input.collectionExtensions,
        input.collectionExtensions,
        input.collectionExtensions,
        undefined,
        bootstrapFailureOptions,
    );
}

function markMetadataRefreshArtifactTaskTerminal(
    input: {
        metadataRefreshFollowups: SqliteMetadataRefreshFollowups;
        job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
    },
    result: CollectionExtensionRefreshArtifactsResult,
): void {
    const runId = input.job.payload.metadataRefreshRunId;
    if (!runId) {
        return;
    }
    input.metadataRefreshFollowups.markExtensionArtifactTaskTerminal({
        runId,
        tokenId: input.job.payload.tokenId,
        extensionKey: resolveMetadataRefreshExtensionKey(input.job),
        status:
            result.status ===
            COLLECTION_EXTENSION_REFRESH_ARTIFACTS_RESULT_STATUS.Skipped
                ? METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS.Skipped
                : METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS.Succeeded,
    });
}

function markMetadataRefreshArtifactTaskFailed(input: {
    metadataRefreshFollowups: SqliteMetadataRefreshFollowups;
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
}): void {
    const runId = input.job.payload.metadataRefreshRunId;
    if (!runId) {
        return;
    }
    input.metadataRefreshFollowups.markExtensionArtifactTaskTerminal({
        runId,
        tokenId: input.job.payload.tokenId,
        extensionKey: resolveMetadataRefreshExtensionKey(input.job),
        status: METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS.FailedTerminal,
    });
}

function resolveMetadataRefreshExtensionKey(
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>,
): NonNullable<
    CollectionExtensionRefreshArtifactsPayload["metadataRefreshExtensionKey"]
> {
    if (!job.payload.metadataRefreshExtensionKey) {
        throw new Error(
            "Metadata refresh extension artifact job missing extension key",
        );
    }
    return job.payload.metadataRefreshExtensionKey;
}

function isFinalCollectionExtensionArtifactAttempt(
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>,
): boolean {
    return (
        Math.max(1, job.attempt) >= COLLECTION_EXTENSION_ARTIFACT_MAX_ATTEMPTS
    );
}

function markBootstrapArtifactTaskSucceeded(input: {
    metadataRefreshFollowups: SqliteMetadataRefreshFollowups;
    bootstrapStorage: BootstrapSnapshotPort;
    bootstrapRuns: BootstrapRunsPort;
    bootstrapSteps: BootstrapStepsPort;
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
}): void {
    const bootstrap = input.job.payload.bootstrap;
    if (!bootstrap) {
        return;
    }
    input.bootstrapStorage.markCollectionExtensionArtifactTaskSucceeded({
        runId: bootstrap.runId,
        tokenId: input.job.payload.tokenId,
        extensionKey: bootstrap.extensionKey,
        attempts: Math.max(1, input.job.attempt),
    });
    finalizeBootstrapArtifactTaskProgress(input);
}

async function markBootstrapArtifactTaskFailed(
    input: {
        queue: NatsJetStreamQueue;
        metadataRefreshFollowups: SqliteMetadataRefreshFollowups;
        bootstrapStorage: BootstrapSnapshotPort;
        bootstrapRuns: BootstrapRunsPort;
        bootstrapSteps: BootstrapStepsPort;
        retryPolicy: RetryPolicy;
        job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
    },
    error: string,
    options: { forceTerminal: boolean },
): Promise<void> {
    const bootstrap = input.job.payload.bootstrap;
    if (!bootstrap) {
        return;
    }

    const attempts = Math.max(1, input.job.attempt);
    const failedTerminal =
        options.forceTerminal ||
        attempts >= Math.max(1, input.retryPolicy.maxAttempts);
    const retryDelay = getRetryDelayMs(attempts, input.retryPolicy);
    const nextAttemptAt = failedTerminal ? 0 : Date.now() + retryDelay;
    input.bootstrapStorage.markCollectionExtensionArtifactTaskRetry({
        runId: bootstrap.runId,
        tokenId: input.job.payload.tokenId,
        extensionKey: bootstrap.extensionKey,
        attempts,
        nextAttemptAt,
        lastError: error,
        failedTerminal,
    });
    finalizeBootstrapArtifactTaskProgress(input);
    if (failedTerminal) {
        return;
    }

    await publishCollectionExtensionRefreshArtifacts(
        input.queue,
        input.job.payload,
        input.job.traceId ?? input.job.jobId,
        {
            attempt: attempts + 1,
            delayMs: retryDelay,
        },
    );
}

function isDeterministicBootstrapArtifactFailure(message: string): boolean {
    return (
        message ===
            BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE.InstallMissing ||
        message ===
            BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE.ImplementationMissing
    );
}

function finalizeBootstrapArtifactTaskProgress(input: {
    metadataRefreshFollowups: SqliteMetadataRefreshFollowups;
    bootstrapStorage: BootstrapSnapshotPort;
    bootstrapRuns: BootstrapRunsPort;
    bootstrapSteps: BootstrapStepsPort;
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
}): void {
    const bootstrap = input.job.payload.bootstrap;
    if (!bootstrap) {
        return;
    }
    const run = input.bootstrapRuns.getRun(bootstrap.runId);
    if (!run) {
        return;
    }
    const counts =
        input.bootstrapStorage.getCollectionExtensionArtifactTaskCounts(
            bootstrap.runId,
        );
    updateCollectionExtensionArtifactStepProgress({
        stepsPort: input.bootstrapSteps,
        runId: bootstrap.runId,
        counts,
    });
    const terminal = completeCollectionExtensionArtifactStepIfTerminal({
        runsPort: input.bootstrapRuns,
        stepsPort: input.bootstrapSteps,
        run,
        counts,
    });
    if (!terminal) {
        return;
    }

    input.metadataRefreshFollowups.enqueueFinalStatsOnce({
        run: buildBootstrapFinalStatsFollowupRun({
            bootstrapRunId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            statsReason: METADATA_STATS_RECOMPUTE_REASON.BootstrapFinalized,
            sourceJobId: input.job.jobId,
            traceId: input.job.traceId ?? input.job.jobId,
        }),
    });
    const cleanup = cleanupSuccessfulBootstrapTemporaryData({
        bootstrapStorage: input.bootstrapStorage,
        bootstrapRuns: input.bootstrapRuns,
        runId: bootstrap.runId,
        collectionExtensionArtifactsTerminal: true,
    });
    logBootstrapTemporaryDataCleanup(cleanup);
}

function logBootstrapTemporaryDataCleanup(
    cleanup: BootstrapTemporaryDataCleanupResult,
): void {
    if (!cleanup.deleted) {
        return;
    }

    logger.info("Bootstrap temporary data cleaned up", {
        component: "CollectionExtensionWorker",
        action: "cleanupBootstrapTemporaryData",
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
