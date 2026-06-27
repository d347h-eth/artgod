import { createMigrationRunner } from "@artgod/shared/migrations";
import { setDbPath } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { loadConfig } from "../config/index.js";
import { BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE } from "../application/bootstrap-collection-extension-artifacts.js";
import { type BootstrapTemporaryDataCleanupResult } from "../application/bootstrap-temporary-data-cleanup.js";
import {
    handleCollectionExtensionRefreshArtifactsJob,
    type CollectionExtensionRefreshArtifactsResult,
} from "../application/collection-extensions/refresh-artifacts-worker.js";
import {
    handleCollectionExtensionRefreshArtifactsLifecycle,
    resolveCollectionExtensionArtifactLeaseRenewMs,
} from "../application/collection-extensions/refresh-artifacts-lifecycle.js";
import { runWorker } from "../application/worker-runner.js";
import {
    COLLECTION_EXTENSION_JOB_KIND,
    type CollectionExtensionRefreshArtifactsPayload,
} from "../domain/collection-extension-jobs.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { QUEUE_NAMES } from "../domain/queues.js";
import type { RetryPolicy } from "../domain/retry.js";
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
        const collectionExtensions = new SqliteCollectionExtensions(
            config.debugPayloads,
        );
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
                maxInFlight:
                    config.bootstrap.collectionExtensionArtifactConcurrency,
                extendLeaseMs: resolveCollectionExtensionArtifactLeaseRenewMs(
                    config.bootstrap.collectionExtensionArtifactTaskLeaseMs,
                ),
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
                    bootstrapArtifactTaskLeaseMs:
                        config.bootstrap.collectionExtensionArtifactTaskLeaseMs,
                    collectionExtensionArtifactMaxAttempts:
                        COLLECTION_EXTENSION_ARTIFACT_MAX_ATTEMPTS,
                    rpc,
                    metadataFetcher,
                    bootstrapRetryPolicy: config.bootstrap.metadataRetryPolicy,
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
    bootstrapArtifactTaskLeaseMs: number;
    collectionExtensionArtifactMaxAttempts: number;
    rpc: ViemRpcProvider;
    metadataFetcher: HttpMetadataFetcher;
    bootstrapRetryPolicy: RetryPolicy;
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
}): Promise<void> {
    await handleCollectionExtensionRefreshArtifactsLifecycle({
        queue: input.queue,
        metadataRefreshFollowups: input.metadataRefreshFollowups,
        bootstrapStorage: input.bootstrapStorage,
        bootstrapRuns: input.bootstrapRuns,
        bootstrapSteps: input.bootstrapSteps,
        bootstrapArtifactTaskLeaseMs: input.bootstrapArtifactTaskLeaseMs,
        collectionExtensionArtifactMaxAttempts:
            input.collectionExtensionArtifactMaxAttempts,
        bootstrapRetryPolicy: input.bootstrapRetryPolicy,
        job: input.job,
        refreshArtifacts: () => refreshArtifacts(input),
        onTemporaryDataCleanup: logBootstrapTemporaryDataCleanup,
    });
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
        input.collectionExtensions,
        undefined,
        bootstrapFailureOptions,
    );
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
