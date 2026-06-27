import { randomUUID } from "crypto";
import type { CollectionExtensionKey } from "@artgod/shared/extensions";
import {
    BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE,
    completeCollectionExtensionArtifactStepIfTerminal,
    type BootstrapCollectionExtensionArtifactRunsPort,
    type BootstrapCollectionExtensionArtifactStepsPort,
    updateCollectionExtensionArtifactStepProgress,
} from "../bootstrap-collection-extension-artifacts.js";
import {
    cleanupSuccessfulBootstrapTemporaryData,
    type BootstrapTemporaryDataCleanupResult,
    type BootstrapTemporaryDataRunsPort,
    type BootstrapTemporaryDataStoragePort,
} from "../bootstrap-temporary-data-cleanup.js";
import {
    buildBootstrapFinalStatsFollowupRun,
    type MetadataRefreshFollowupRunInput,
} from "../metadata/refresh-followups.js";
import {
    COLLECTION_EXTENSION_REFRESH_ARTIFACTS_RESULT_STATUS,
    type CollectionExtensionRefreshArtifactsResult,
} from "./refresh-artifacts-worker.js";
import { publishCollectionExtensionRefreshArtifacts } from "./jobs.js";
import {
    METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS,
    type MetadataRefreshExtensionArtifactTerminalStatus,
} from "../../domain/metadata-refresh-followups.js";
import { METADATA_STATS_RECOMPUTE_REASON } from "../../domain/domain-jobs.js";
import type { CollectionExtensionRefreshArtifactsPayload } from "../../domain/collection-extension-jobs.js";
import type { JobEnvelope } from "../../domain/jobs.js";
import { getRetryDelayMs, type RetryPolicy } from "../../domain/retry.js";
import type {
    BootstrapCollectionExtensionArtifactTask,
    BootstrapCollectionExtensionArtifactTaskCounts,
} from "../../ports/bootstrap.js";
import type { QueuePort } from "../../ports/queue.js";

// Lease owner scope for one collection-extension artifact task execution.
export const COLLECTION_EXTENSION_ARTIFACT_TASK_LEASE_OWNER_SCOPE =
    "collection-extension-artifact";

// Claimed bootstrap artifact task plus the owner fence for its execution.
export type BootstrapArtifactTaskExecution = {
    task: BootstrapCollectionExtensionArtifactTask;
    leaseOwner: string;
};

// Storage boundary for claiming and settling bootstrap-owned artifact tasks.
export interface CollectionExtensionArtifactBootstrapStoragePort extends BootstrapTemporaryDataStoragePort {
    claimCollectionExtensionArtifactTask(input: {
        runId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        nowMs: number;
        leaseOwner: string;
        leaseUntil: number;
    }): BootstrapCollectionExtensionArtifactTask | null;
    renewCollectionExtensionArtifactTaskLease(input: {
        runId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        leaseOwner: string;
        leaseUntil: number;
    }): boolean;
    markCollectionExtensionArtifactTaskSucceeded(input: {
        runId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        leaseOwner: string;
        attempts: number;
    }): boolean;
    markCollectionExtensionArtifactTaskRetry(input: {
        runId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        leaseOwner: string;
        attempts: number;
        nextAttemptAt: number;
        lastError: string;
        failedTerminal: boolean;
    }): boolean;
    getCollectionExtensionArtifactTaskCounts(
        runId: number,
    ): BootstrapCollectionExtensionArtifactTaskCounts;
}

// Run boundary used to read bootstrap state and append side-lane events.
export type CollectionExtensionArtifactBootstrapRunsPort =
    BootstrapTemporaryDataRunsPort &
        BootstrapCollectionExtensionArtifactRunsPort;

// Step boundary used to publish bootstrap artifact side-lane progress.
export type CollectionExtensionArtifactBootstrapStepsPort =
    BootstrapCollectionExtensionArtifactStepsPort;

// Follow-up boundary for metadata refresh task terminality and final stats.
export interface CollectionExtensionArtifactMetadataFollowupsPort {
    markExtensionArtifactTaskTerminal(input: {
        runId: string;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        status: MetadataRefreshExtensionArtifactTerminalStatus;
    }): void;
    enqueueFinalStatsOnce(input: {
        run: MetadataRefreshFollowupRunInput;
    }): boolean;
}

// Executes extension-specific artifact refresh after lifecycle claim succeeds.
export type CollectionExtensionArtifactRefreshExecutor =
    () => Promise<CollectionExtensionRefreshArtifactsResult>;

// Inputs needed to coordinate one delivered collection-extension artifact job.
export type CollectionExtensionRefreshArtifactsLifecycleInput = {
    queue: QueuePort;
    metadataRefreshFollowups: CollectionExtensionArtifactMetadataFollowupsPort;
    bootstrapStorage: CollectionExtensionArtifactBootstrapStoragePort;
    bootstrapRuns: CollectionExtensionArtifactBootstrapRunsPort;
    bootstrapSteps: CollectionExtensionArtifactBootstrapStepsPort;
    bootstrapArtifactTaskLeaseMs: number;
    collectionExtensionArtifactMaxAttempts: number;
    bootstrapRetryPolicy: RetryPolicy;
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
    refreshArtifacts: CollectionExtensionArtifactRefreshExecutor;
    nowMs?: () => number;
    randomId?: () => string;
    onTemporaryDataCleanup?: (
        cleanup: BootstrapTemporaryDataCleanupResult,
    ) => void;
};

// Handles one extension artifact job after queue delivery, including owner-run settlement.
export async function handleCollectionExtensionRefreshArtifactsLifecycle(
    input: CollectionExtensionRefreshArtifactsLifecycleInput,
): Promise<void> {
    const job = input.job;
    const bootstrapExecution = claimBootstrapArtifactTask(input);
    if (job.payload.bootstrap && !bootstrapExecution) {
        finalizeBootstrapArtifactTaskProgress(input);
        return;
    }
    const stopBootstrapLeaseRenewal = bootstrapExecution
        ? startBootstrapArtifactTaskLeaseRenewal(input, bootstrapExecution)
        : undefined;

    try {
        const result = await input.refreshArtifacts();
        markMetadataRefreshArtifactTaskTerminal(input, result);
        markBootstrapArtifactTaskSucceeded(input, bootstrapExecution);
    } catch (error) {
        if (
            job.payload.metadataRefreshRunId &&
            isFinalCollectionExtensionArtifactAttempt(
                job,
                input.collectionExtensionArtifactMaxAttempts,
            )
        ) {
            markMetadataRefreshArtifactTaskFailed(input);
        }
        if (!job.payload.bootstrap) {
            throw error;
        }
        const message = resolveCollectionExtensionArtifactTaskError(error);
        await markBootstrapArtifactTaskFailed(input, message, {
            forceTerminal: isDeterministicBootstrapArtifactFailure(message),
            execution: bootstrapExecution,
        });
    } finally {
        stopBootstrapLeaseRenewal?.();
    }
}

// Claims a bootstrap-owned task row and returns the settlement fence.
export function claimBootstrapArtifactTask(input: {
    bootstrapStorage: CollectionExtensionArtifactBootstrapStoragePort;
    bootstrapArtifactTaskLeaseMs: number;
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
    nowMs?: () => number;
    randomId?: () => string;
}): BootstrapArtifactTaskExecution | null {
    const bootstrap = input.job.payload.bootstrap;
    if (!bootstrap) {
        return null;
    }
    const nowMs = (input.nowMs ?? Date.now)();
    const leaseOwner = buildBootstrapArtifactTaskLeaseOwner(
        input.job,
        input.randomId ?? randomUUID,
    );
    const task = input.bootstrapStorage.claimCollectionExtensionArtifactTask({
        runId: bootstrap.runId,
        tokenId: input.job.payload.tokenId,
        extensionKey: bootstrap.extensionKey,
        nowMs,
        leaseOwner,
        leaseUntil: nowMs + Math.max(1, input.bootstrapArtifactTaskLeaseMs),
    });
    return task ? { task, leaseOwner } : null;
}

// Builds a unique lease owner for one bootstrap artifact task execution.
export function buildBootstrapArtifactTaskLeaseOwner(
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>,
    randomId: () => string = randomUUID,
): string {
    const bootstrap = job.payload.bootstrap;
    if (!bootstrap) {
        throw new Error(
            "Bootstrap artifact task lease requires bootstrap payload",
        );
    }
    return [
        COLLECTION_EXTENSION_ARTIFACT_TASK_LEASE_OWNER_SCOPE,
        job.chainId,
        bootstrap.runId,
        job.payload.tokenId,
        randomId(),
    ].join(":");
}

// Keeps a claimed bootstrap task from being reclaimed while refresh is active.
export function startBootstrapArtifactTaskLeaseRenewal(
    input: {
        bootstrapStorage: CollectionExtensionArtifactBootstrapStoragePort;
        bootstrapArtifactTaskLeaseMs: number;
        job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
        nowMs?: () => number;
    },
    execution: BootstrapArtifactTaskExecution,
): () => void {
    const bootstrap = input.job.payload.bootstrap;
    if (!bootstrap) {
        return () => {};
    }
    const leaseMs = Math.max(1, input.bootstrapArtifactTaskLeaseMs);
    const intervalMs = resolveCollectionExtensionArtifactLeaseRenewMs(leaseMs);
    const timer = setInterval(() => {
        const nowMs = input.nowMs ?? Date.now;
        const renewed =
            input.bootstrapStorage.renewCollectionExtensionArtifactTaskLease({
                runId: bootstrap.runId,
                tokenId: input.job.payload.tokenId,
                extensionKey: bootstrap.extensionKey,
                leaseOwner: execution.leaseOwner,
                leaseUntil: nowMs() + leaseMs,
            });
        if (!renewed) {
            clearInterval(timer);
        }
    }, intervalMs);
    return () => clearInterval(timer);
}

// Renews at a fraction of the full task lease to leave room for retry jitter.
export function resolveCollectionExtensionArtifactLeaseRenewMs(
    leaseMs: number,
): number {
    return Math.max(1, Math.floor(Math.max(1, leaseMs) / 3));
}

function markMetadataRefreshArtifactTaskTerminal(
    input: {
        metadataRefreshFollowups: CollectionExtensionArtifactMetadataFollowupsPort;
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
    metadataRefreshFollowups: CollectionExtensionArtifactMetadataFollowupsPort;
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
): CollectionExtensionKey {
    if (!job.payload.metadataRefreshExtensionKey) {
        throw new Error(
            "Metadata refresh extension artifact job missing extension key",
        );
    }
    return job.payload.metadataRefreshExtensionKey;
}

function isFinalCollectionExtensionArtifactAttempt(
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>,
    maxAttempts: number,
): boolean {
    return Math.max(1, job.attempt) >= Math.max(1, maxAttempts);
}

function markBootstrapArtifactTaskSucceeded(
    input: {
        bootstrapStorage: CollectionExtensionArtifactBootstrapStoragePort;
        bootstrapRuns: CollectionExtensionArtifactBootstrapRunsPort;
        bootstrapSteps: CollectionExtensionArtifactBootstrapStepsPort;
        metadataRefreshFollowups: CollectionExtensionArtifactMetadataFollowupsPort;
        job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
        onTemporaryDataCleanup?: (
            cleanup: BootstrapTemporaryDataCleanupResult,
        ) => void;
    },
    execution: BootstrapArtifactTaskExecution | null,
): void {
    const bootstrap = input.job.payload.bootstrap;
    if (!bootstrap || !execution) {
        return;
    }
    const settled =
        input.bootstrapStorage.markCollectionExtensionArtifactTaskSucceeded({
            runId: bootstrap.runId,
            tokenId: input.job.payload.tokenId,
            extensionKey: bootstrap.extensionKey,
            leaseOwner: execution.leaseOwner,
            attempts: execution.task.attempts,
        });
    if (!settled) {
        return;
    }
    finalizeBootstrapArtifactTaskProgress(input);
}

async function markBootstrapArtifactTaskFailed(
    input: {
        queue: QueuePort;
        metadataRefreshFollowups: CollectionExtensionArtifactMetadataFollowupsPort;
        bootstrapStorage: CollectionExtensionArtifactBootstrapStoragePort;
        bootstrapRuns: CollectionExtensionArtifactBootstrapRunsPort;
        bootstrapSteps: CollectionExtensionArtifactBootstrapStepsPort;
        bootstrapRetryPolicy: RetryPolicy;
        job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
        nowMs?: () => number;
        onTemporaryDataCleanup?: (
            cleanup: BootstrapTemporaryDataCleanupResult,
        ) => void;
    },
    error: string,
    options: {
        forceTerminal: boolean;
        execution: BootstrapArtifactTaskExecution | null;
    },
): Promise<void> {
    const bootstrap = input.job.payload.bootstrap;
    if (!bootstrap || !options.execution) {
        return;
    }

    const attempts = Math.max(1, options.execution.task.attempts);
    const failedTerminal =
        options.forceTerminal ||
        attempts >= Math.max(1, input.bootstrapRetryPolicy.maxAttempts);
    const retryDelay = getRetryDelayMs(attempts, input.bootstrapRetryPolicy);
    const nextAttemptAt = failedTerminal
        ? 0
        : (input.nowMs ?? Date.now)() + retryDelay;
    const settled =
        input.bootstrapStorage.markCollectionExtensionArtifactTaskRetry({
            runId: bootstrap.runId,
            tokenId: input.job.payload.tokenId,
            extensionKey: bootstrap.extensionKey,
            leaseOwner: options.execution.leaseOwner,
            attempts,
            nextAttemptAt,
            lastError: error,
            failedTerminal,
        });
    if (!settled) {
        return;
    }
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

function resolveCollectionExtensionArtifactTaskError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function finalizeBootstrapArtifactTaskProgress(input: {
    metadataRefreshFollowups: CollectionExtensionArtifactMetadataFollowupsPort;
    bootstrapStorage: CollectionExtensionArtifactBootstrapStoragePort;
    bootstrapRuns: CollectionExtensionArtifactBootstrapRunsPort;
    bootstrapSteps: CollectionExtensionArtifactBootstrapStepsPort;
    job: JobEnvelope<CollectionExtensionRefreshArtifactsPayload>;
    onTemporaryDataCleanup?: (
        cleanup: BootstrapTemporaryDataCleanupResult,
    ) => void;
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
    input.onTemporaryDataCleanup?.(cleanup);
}
