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
import { resolveIndexerCollectionExtension } from "../application/collection-extensions/index.js";
import { runWorker } from "../application/worker-runner.js";
import { publishCollectionExtensionRefreshArtifacts } from "../application/collection-extensions/jobs.js";
import {
    COLLECTION_EXTENSION_JOB_KIND,
    type CollectionExtensionRefreshArtifactsPayload,
} from "../domain/collection-extension-jobs.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import { getRetryDelayMs, type RetryPolicy } from "../domain/retry.js";
import { SqliteBootstrapRuns } from "../infra/bootstrap/sqlite-runs.js";
import { SqliteBootstrapSteps } from "../infra/bootstrap/sqlite-steps.js";
import { SqliteBootstrapStorage } from "../infra/bootstrap/sqlite.js";
import { SqliteCollectionExtensions } from "../infra/collection-extensions/sqlite.js";
import { HttpMetadataFetcher } from "../infra/metadata/http-fetcher.js";
import { NatsJetStreamQueue } from "../infra/queue/nats.js";
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
                maxAttempts: 5,
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
        await refreshArtifacts(input);
        markBootstrapArtifactTaskSucceeded(input);
    } catch (error) {
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
    collectionExtensions: SqliteCollectionExtensions;
    rpc: ViemRpcProvider;
    metadataFetcher: HttpMetadataFetcher;
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
}): Promise<void> {
    const job = input.job;
    const install = input.collectionExtensions.getInstall(
        job.payload.chainId,
        job.payload.collectionId,
    );

    if (!install?.enabled) {
        if (job.payload.bootstrap) {
            throw new Error(
                BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE.InstallMissing,
            );
        }
        logger.debug(
            "Collection extension artifact refresh skipped; install missing",
            {
                component: "CollectionExtensionWorker",
                action: "handleRefreshArtifacts",
                chainId: job.payload.chainId,
                collectionId: job.payload.collectionId,
                contract: job.payload.contract,
                tokenId: job.payload.tokenId,
                reason: job.payload.reason,
            },
        );
        return;
    }

    const extension = resolveIndexerCollectionExtension(install);
    if (!extension) {
        if (job.payload.bootstrap) {
            throw new Error(
                BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE.ImplementationMissing,
            );
        }
        logger.warn(
            "Collection extension artifact refresh skipped; extension implementation missing",
            {
                component: "CollectionExtensionWorker",
                action: "handleRefreshArtifacts",
                chainId: job.payload.chainId,
                collectionId: install.collectionId,
                extensionKey: install.extensionKey,
                contract: job.payload.contract,
                tokenId: job.payload.tokenId,
            },
        );
        return;
    }

    await extension.refreshArtifacts({
        rpc: input.rpc,
        metadataFetcher: input.metadataFetcher,
        installs: input.collectionExtensions,
        artifacts: input.collectionExtensions,
        install,
        payload: {
            chainId: job.payload.chainId,
            collectionId: install.collectionId,
            contract: job.payload.contract,
            tokenId: job.payload.tokenId,
            reason: job.payload.reason,
            source: job.payload.source,
        },
    });
}

function markBootstrapArtifactTaskSucceeded(input: {
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

    const cleanup = cleanupSuccessfulBootstrapTemporaryData({
        bootstrapStorage: input.bootstrapStorage,
        bootstrapRuns: input.bootstrapRuns,
        runId: bootstrap.runId,
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
