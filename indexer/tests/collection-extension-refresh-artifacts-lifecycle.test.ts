import { describe, expect, it, vi } from "vitest";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_TASK_STATUS,
    type BootstrapTaskCounts,
} from "@artgod/shared/bootstrap/pipeline";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-image-source";
import { TERRAFORMS_EXTENSION_KEY } from "@artgod/shared/extensions/terraforms";
import {
    BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE,
    type BootstrapCollectionExtensionArtifactRunsPort,
    type BootstrapCollectionExtensionArtifactStepsPort,
} from "../src/application/bootstrap-collection-extension-artifacts.js";
import {
    buildBootstrapArtifactTaskLeaseOwner,
    claimBootstrapArtifactTask,
    COLLECTION_EXTENSION_ARTIFACT_TASK_LEASE_OWNER_SCOPE,
    handleCollectionExtensionRefreshArtifactsLifecycle,
    resolveCollectionExtensionArtifactLeaseRenewMs,
    type CollectionExtensionArtifactBootstrapStoragePort,
    type CollectionExtensionArtifactMetadataFollowupsPort,
} from "../src/application/collection-extensions/refresh-artifacts-lifecycle.js";
import { COLLECTION_EXTENSION_REFRESH_ARTIFACTS_RESULT_STATUS } from "../src/application/collection-extensions/refresh-artifacts-worker.js";
import {
    COLLECTION_EXTENSION_JOB_KIND,
    type CollectionExtensionRefreshArtifactsPayload,
} from "../src/domain/collection-extension-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS } from "../src/domain/metadata-refresh-followups.js";
import { QUEUE_NAMES, type QueueName } from "../src/domain/queues.js";
import type { BootstrapRunDefinition } from "../src/ports/bootstrap-runs.js";
import type {
    QueueMessage,
    QueuePort,
    SubscribeOptions,
} from "../src/ports/queue.js";

const TEST_CHAIN_ID = 1;
const TEST_COLLECTION_ID = 7;
const TEST_RUN_ID = 41;
const TEST_CONTRACT = "0xabc0000000000000000000000000000000000000";
const TEST_TOKEN_ID = "42";
const TEST_JOB_ID = "collection-extension-lifecycle-test-job";
const TEST_TRACE_ID = "collection-extension-lifecycle-test-trace";
const TEST_METADATA_REFRESH_RUN_ID = "metadata-refresh-test-run";
const TEST_LEASE_ID = "test-lease-id";
const TEST_NOW_MS = 1_000;
const TEST_LEASE_MS = 60_000;
const TEST_REFRESH_ARTIFACT_MAX_ATTEMPTS = 5;
const TEST_BOOTSTRAP_RETRY_POLICY = {
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
};

describe("collection extension refresh artifact lifecycle", () => {
    it("builds bootstrap artifact lease owners with the shared owner scope", () => {
        const leaseOwner = buildBootstrapArtifactTaskLeaseOwner(
            buildRefreshJob({ bootstrap: bootstrapContext() }),
            () => TEST_LEASE_ID,
        );

        expect(leaseOwner).toBe(
            [
                COLLECTION_EXTENSION_ARTIFACT_TASK_LEASE_OWNER_SCOPE,
                TEST_CHAIN_ID,
                TEST_RUN_ID,
                TEST_TOKEN_ID,
                TEST_LEASE_ID,
            ].join(":"),
        );
    });

    it("claims bootstrap artifact tasks with the configured lease window", () => {
        const task = buildArtifactTask({ attempts: 1 });
        const storage = createStorage({ claimTask: task });
        const job = buildRefreshJob({ bootstrap: bootstrapContext() });

        const execution = claimBootstrapArtifactTask({
            bootstrapStorage: storage,
            bootstrapArtifactTaskLeaseMs: TEST_LEASE_MS,
            job,
            nowMs: () => TEST_NOW_MS,
            randomId: () => TEST_LEASE_ID,
        });

        expect(execution).toEqual({
            task,
            leaseOwner: [
                COLLECTION_EXTENSION_ARTIFACT_TASK_LEASE_OWNER_SCOPE,
                TEST_CHAIN_ID,
                TEST_RUN_ID,
                TEST_TOKEN_ID,
                TEST_LEASE_ID,
            ].join(":"),
        });
        expect(
            storage.claimCollectionExtensionArtifactTask,
        ).toHaveBeenCalledWith({
            runId: TEST_RUN_ID,
            tokenId: TEST_TOKEN_ID,
            extensionKey: TERRAFORMS_EXTENSION_KEY,
            nowMs: TEST_NOW_MS,
            leaseOwner: execution?.leaseOwner,
            leaseUntil: TEST_NOW_MS + TEST_LEASE_MS,
        });
    });

    it("skips bootstrap refresh when another worker already owns the task", async () => {
        const harness = createHarness({
            claimTask: null,
            artifactCounts: taskCounts({ pending: 1, total: 1 }),
        });
        const refreshArtifacts = vi.fn(async () => refreshedResult());

        await handleCollectionExtensionRefreshArtifactsLifecycle({
            ...harness.input,
            job: buildRefreshJob({ bootstrap: bootstrapContext() }),
            refreshArtifacts,
        });

        expect(refreshArtifacts).not.toHaveBeenCalled();
        expect(harness.steps.succeeded).toEqual([]);
        expect(harness.metadataRefreshFollowups.enqueuedFinalStats).toEqual([]);
        expect(harness.queue.published).toEqual([]);
    });

    it("settles successful bootstrap refreshes through the claimed task fence", async () => {
        const harness = createHarness({
            claimTask: buildArtifactTask({ attempts: 1 }),
            artifactCounts: taskCounts({ succeeded: 1, total: 1 }),
            deleteSucceededCollectionExtensionArtifactTasks: 1,
        });

        await handleCollectionExtensionRefreshArtifactsLifecycle({
            ...harness.input,
            job: buildRefreshJob({ bootstrap: bootstrapContext() }),
            refreshArtifacts: async () => refreshedResult(),
        });

        expect(
            harness.storage.markCollectionExtensionArtifactTaskSucceeded,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                runId: TEST_RUN_ID,
                tokenId: TEST_TOKEN_ID,
                extensionKey: TERRAFORMS_EXTENSION_KEY,
                attempts: 1,
            }),
        );
        expect(harness.steps.succeeded).toEqual([
            {
                runId: TEST_RUN_ID,
                stepKey: BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
                progress: { completed: 1, total: 1 },
            },
        ]);
        expect(
            harness.metadataRefreshFollowups.enqueuedFinalStats,
        ).toHaveLength(1);
        expect(harness.cleanup).toEqual([
            expect.objectContaining({
                deleted: true,
                collectionExtensionArtifactTasks: 1,
            }),
        ]);
    });

    it("does not retry or finalize stale bootstrap failures after settlement loses the fence", async () => {
        const harness = createHarness({
            claimTask: buildArtifactTask({ attempts: 2 }),
            retrySettled: false,
            artifactCounts: taskCounts({ retry: 1, total: 1 }),
        });

        await handleCollectionExtensionRefreshArtifactsLifecycle({
            ...harness.input,
            job: buildRefreshJob({ bootstrap: bootstrapContext() }),
            refreshArtifacts: async () => {
                throw new Error("transient lifecycle failure");
            },
        });

        expect(
            harness.storage.markCollectionExtensionArtifactTaskRetry,
        ).toHaveBeenCalled();
        expect(harness.queue.published).toEqual([]);
        expect(harness.steps.failedTerminal).toEqual([]);
        expect(harness.metadataRefreshFollowups.enqueuedFinalStats).toEqual([]);
    });

    it("reschedules retryable bootstrap failures after fenced retry settlement", async () => {
        const harness = createHarness({
            claimTask: buildArtifactTask({ attempts: 2 }),
            artifactCounts: taskCounts({ retry: 1, total: 1 }),
        });

        await handleCollectionExtensionRefreshArtifactsLifecycle({
            ...harness.input,
            job: buildRefreshJob({ bootstrap: bootstrapContext() }),
            refreshArtifacts: async () => {
                throw new Error("temporary lifecycle failure");
            },
        });

        expect(
            harness.storage.markCollectionExtensionArtifactTaskRetry,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                runId: TEST_RUN_ID,
                tokenId: TEST_TOKEN_ID,
                extensionKey: TERRAFORMS_EXTENSION_KEY,
                attempts: 2,
                nextAttemptAt: TEST_NOW_MS + 20,
                failedTerminal: false,
            }),
        );
        expect(harness.queue.published).toEqual([
            expect.objectContaining({
                queue: QUEUE_NAMES.CollectionExtensionArtifacts,
                message: expect.objectContaining({
                    attempt: 3,
                    payload: expect.objectContaining({
                        bootstrap: bootstrapContext(),
                    }),
                }),
            }),
        ]);
    });

    it("marks deterministic bootstrap setup failures terminal without publishing retry jobs", async () => {
        const harness = createHarness({
            claimTask: buildArtifactTask({ attempts: 1 }),
            artifactCounts: taskCounts({ failedTerminal: 1, total: 1 }),
        });

        await handleCollectionExtensionRefreshArtifactsLifecycle({
            ...harness.input,
            job: buildRefreshJob({ bootstrap: bootstrapContext() }),
            refreshArtifacts: async () => {
                throw new Error(
                    BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE.InstallMissing,
                );
            },
        });

        expect(
            harness.storage.markCollectionExtensionArtifactTaskRetry,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                attempts: 1,
                nextAttemptAt: 0,
                failedTerminal: true,
            }),
        );
        expect(harness.queue.published).toEqual([]);
        expect(harness.steps.failedTerminal).toEqual([
            expect.objectContaining({
                runId: TEST_RUN_ID,
                stepKey: BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
            }),
        ]);
        expect(
            harness.metadataRefreshFollowups.enqueuedFinalStats,
        ).toHaveLength(1);
    });

    it("uses queue artifact max attempts, not bootstrap retry policy, for metadata-refresh terminality", async () => {
        const firstHarness = createHarness();
        await expect(
            handleCollectionExtensionRefreshArtifactsLifecycle({
                ...firstHarness.input,
                job: buildRefreshJob(
                    {
                        metadataRefreshRunId: TEST_METADATA_REFRESH_RUN_ID,
                        metadataRefreshExtensionKey: TERRAFORMS_EXTENSION_KEY,
                    },
                    { attempt: TEST_BOOTSTRAP_RETRY_POLICY.maxAttempts },
                ),
                refreshArtifacts: async () => {
                    throw new Error("metadata refresh artifact failure");
                },
            }),
        ).rejects.toThrow("metadata refresh artifact failure");
        expect(firstHarness.metadataRefreshFollowups.terminalTasks).toEqual([]);

        const finalHarness = createHarness();
        await expect(
            handleCollectionExtensionRefreshArtifactsLifecycle({
                ...finalHarness.input,
                job: buildRefreshJob(
                    {
                        metadataRefreshRunId: TEST_METADATA_REFRESH_RUN_ID,
                        metadataRefreshExtensionKey: TERRAFORMS_EXTENSION_KEY,
                    },
                    { attempt: TEST_REFRESH_ARTIFACT_MAX_ATTEMPTS },
                ),
                refreshArtifacts: async () => {
                    throw new Error("metadata refresh artifact failure");
                },
            }),
        ).rejects.toThrow("metadata refresh artifact failure");
        expect(finalHarness.metadataRefreshFollowups.terminalTasks).toEqual([
            {
                runId: TEST_METADATA_REFRESH_RUN_ID,
                tokenId: TEST_TOKEN_ID,
                extensionKey: TERRAFORMS_EXTENSION_KEY,
                status: METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS.FailedTerminal,
            },
        ]);
    });

    it("marks metadata-refresh owned skipped artifact tasks terminal", async () => {
        const harness = createHarness();

        await handleCollectionExtensionRefreshArtifactsLifecycle({
            ...harness.input,
            job: buildRefreshJob({
                metadataRefreshRunId: TEST_METADATA_REFRESH_RUN_ID,
                metadataRefreshExtensionKey: TERRAFORMS_EXTENSION_KEY,
            }),
            refreshArtifacts: async () => ({
                status: COLLECTION_EXTENSION_REFRESH_ARTIFACTS_RESULT_STATUS.Skipped,
                attributesChanged: false,
                extensionKey: TERRAFORMS_EXTENSION_KEY,
            }),
        });

        expect(harness.metadataRefreshFollowups.terminalTasks).toEqual([
            {
                runId: TEST_METADATA_REFRESH_RUN_ID,
                tokenId: TEST_TOKEN_ID,
                extensionKey: TERRAFORMS_EXTENSION_KEY,
                status: METADATA_REFRESH_EXTENSION_ARTIFACT_TASK_STATUS.Skipped,
            },
        ]);
    });

    it("resolves bootstrap artifact lease renewal intervals from the task lease", () => {
        expect(resolveCollectionExtensionArtifactLeaseRenewMs(60_000)).toBe(
            20_000,
        );
        expect(resolveCollectionExtensionArtifactLeaseRenewMs(2)).toBe(1);
    });
});

function createHarness(
    options: {
        claimTask?: ReturnType<typeof buildArtifactTask> | null;
        artifactCounts?: BootstrapTaskCounts;
        successSettled?: boolean;
        retrySettled?: boolean;
        deleteSucceededCollectionExtensionArtifactTasks?: number;
    } = {},
) {
    const queue = new RecordingQueue();
    const cleanup: unknown[] = [];
    const storage = createStorage(options);
    const runs = createRuns();
    const steps = createSteps();
    const metadataRefreshFollowups = createMetadataRefreshFollowups();

    return {
        queue,
        cleanup,
        storage,
        runs,
        steps,
        metadataRefreshFollowups,
        input: {
            queue,
            metadataRefreshFollowups,
            bootstrapStorage: storage,
            bootstrapRuns: runs,
            bootstrapSteps: steps,
            bootstrapArtifactTaskLeaseMs: TEST_LEASE_MS,
            collectionExtensionArtifactMaxAttempts:
                TEST_REFRESH_ARTIFACT_MAX_ATTEMPTS,
            bootstrapRetryPolicy: TEST_BOOTSTRAP_RETRY_POLICY,
            nowMs: () => TEST_NOW_MS,
            randomId: () => TEST_LEASE_ID,
            onTemporaryDataCleanup: (result: unknown) => cleanup.push(result),
        },
    };
}

function createStorage(options: {
    claimTask?: ReturnType<typeof buildArtifactTask> | null;
    artifactCounts?: BootstrapTaskCounts;
    successSettled?: boolean;
    retrySettled?: boolean;
    deleteSucceededCollectionExtensionArtifactTasks?: number;
}): CollectionExtensionArtifactBootstrapStoragePort {
    const artifactCounts = options.artifactCounts ?? taskCounts();
    return {
        claimCollectionExtensionArtifactTask: vi.fn(() =>
            options.claimTask === undefined ? null : options.claimTask,
        ),
        renewCollectionExtensionArtifactTaskLease: vi.fn(() => true),
        markCollectionExtensionArtifactTaskSucceeded: vi.fn(
            () => options.successSettled ?? true,
        ),
        markCollectionExtensionArtifactTaskRetry: vi.fn(
            () => options.retrySettled ?? true,
        ),
        getCollectionExtensionArtifactTaskCounts: vi.fn(() => artifactCounts),
        deleteSucceededCollectionExtensionArtifactTasks: vi.fn(
            () => options.deleteSucceededCollectionExtensionArtifactTasks ?? 0,
        ),
        deleteSnapshotRows: vi.fn(() => 0),
        deleteSucceededMetadataTasks: vi.fn(() => 0),
        deleteSucceededImageCacheTasks: vi.fn(() => 0),
        deleteSucceededOwnershipTasks: vi.fn(() => 0),
        getMetadataTaskCounts: vi.fn(() =>
            taskCounts({ succeeded: 1, total: 1 }),
        ),
        getImageCacheTaskCounts: vi.fn(() => taskCounts()),
        getOwnershipTaskCounts: vi.fn(() => taskCounts()),
    };
}

function createRuns(): BootstrapCollectionExtensionArtifactRunsPort & {
    events: Array<{ eventCode: string }>;
} {
    const events: Array<{ eventCode: string }> = [];
    return {
        events,
        getRun: () => buildRun(),
        appendRunEvent: (event) => {
            events.push({ eventCode: event.eventCode });
        },
    };
}

function createSteps(): BootstrapCollectionExtensionArtifactStepsPort & {
    succeeded: Array<{
        runId: number;
        stepKey: typeof BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts;
        progress: { completed: number; total: number | null };
    }>;
    failedTerminal: Array<{
        runId: number;
        stepKey: typeof BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts;
        attempts: number;
        error: string;
    }>;
} {
    const succeeded: Array<{
        runId: number;
        stepKey: typeof BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts;
        progress: { completed: number; total: number | null };
    }> = [];
    const failedTerminal: Array<{
        runId: number;
        stepKey: typeof BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts;
        attempts: number;
        error: string;
    }> = [];
    return {
        succeeded,
        failedTerminal,
        getStep: () => null,
        markStepSucceeded: (runId, stepKey, progress) => {
            succeeded.push({
                runId,
                stepKey,
                progress: progress ?? { completed: 1, total: 1 },
            });
        },
        markStepSkipped: vi.fn(),
        markStepFailedTerminal: (input) => {
            failedTerminal.push(input);
        },
        updateStepProgress: vi.fn(),
    };
}

function createMetadataRefreshFollowups(): CollectionExtensionArtifactMetadataFollowupsPort & {
    terminalTasks: Array<{
        runId: string;
        tokenId: string;
        extensionKey: typeof TERRAFORMS_EXTENSION_KEY;
        status: string;
    }>;
    enqueuedFinalStats: unknown[];
} {
    const terminalTasks: Array<{
        runId: string;
        tokenId: string;
        extensionKey: typeof TERRAFORMS_EXTENSION_KEY;
        status: string;
    }> = [];
    const enqueuedFinalStats: unknown[] = [];
    return {
        terminalTasks,
        enqueuedFinalStats,
        markExtensionArtifactTaskTerminal: (input) => {
            terminalTasks.push({
                runId: input.runId,
                tokenId: input.tokenId,
                extensionKey: input.extensionKey,
                status: input.status,
            });
        },
        enqueueFinalStatsOnce: (input) => {
            enqueuedFinalStats.push(input);
            return true;
        },
    };
}

function buildRefreshJob(
    payload: Partial<CollectionExtensionRefreshArtifactsPayload> = {},
    options: { attempt?: number } = {},
): JobEnvelope<CollectionExtensionRefreshArtifactsPayload> {
    return {
        jobId: TEST_JOB_ID,
        kind: COLLECTION_EXTENSION_JOB_KIND.RefreshArtifacts,
        queue: QUEUE_NAMES.CollectionExtensionArtifacts,
        payload: {
            chainId: TEST_CHAIN_ID,
            collectionId: TEST_COLLECTION_ID,
            contract: TEST_CONTRACT,
            tokenId: TEST_TOKEN_ID,
            reason: "test-refresh",
            source: "test-source",
            ...payload,
        },
        attempt: options.attempt ?? 0,
        scheduledAt: 0,
        chainId: TEST_CHAIN_ID,
        collectionId: TEST_COLLECTION_ID,
        traceId: TEST_TRACE_ID,
    };
}

function bootstrapContext() {
    return {
        runId: TEST_RUN_ID,
        extensionKey: TERRAFORMS_EXTENSION_KEY,
    };
}

function buildArtifactTask(input: { attempts: number }) {
    return {
        runId: TEST_RUN_ID,
        chainId: TEST_CHAIN_ID,
        collectionId: TEST_COLLECTION_ID,
        contract: TEST_CONTRACT,
        tokenId: TEST_TOKEN_ID,
        extensionKey: TERRAFORMS_EXTENSION_KEY,
        status: BOOTSTRAP_TASK_STATUS.Pending,
        attempts: input.attempts,
        nextAttemptAt: 0,
        leaseOwner: null,
        leaseUntil: null,
    };
}

function buildRun(): BootstrapRunDefinition {
    return {
        runId: TEST_RUN_ID,
        chainId: TEST_CHAIN_ID,
        collectionId: TEST_COLLECTION_ID,
        requestSlug: "test-collection",
        requestAddress: TEST_CONTRACT,
        requestStandard: "erc721",
        imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
        requestExtensionKey: TERRAFORMS_EXTENSION_KEY,
        metadataMode: BOOTSTRAP_METADATA_MODE.Strict,
        enumerationMode: BOOTSTRAP_ENUMERATION_MODE.Enumerable,
        manualTokenIdsJson: null,
        manualRangeStartTokenId: null,
        manualRangeTotalSupply: null,
        imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
        imageCacheMaxDimension: null,
        deploymentBlock: null,
        status: BOOTSTRAP_RUN_STATUS.Completed,
        anchorBlock: 100,
        anchorBlockHash: `0x${"11".repeat(32)}`,
        anchorBlockTimestamp: 1_726_000_000,
    };
}

function refreshedResult() {
    return {
        status: COLLECTION_EXTENSION_REFRESH_ARTIFACTS_RESULT_STATUS.Refreshed,
        attributesChanged: true,
        extensionKey: TERRAFORMS_EXTENSION_KEY,
    };
}

function taskCounts(overrides: Partial<BootstrapTaskCounts> = {}) {
    return {
        pending: 0,
        retry: 0,
        succeeded: 0,
        failedTerminal: 0,
        total: 0,
        ...overrides,
    };
}

class RecordingQueue implements QueuePort {
    readonly published: Array<{
        queue: QueueName;
        message: JobEnvelope<unknown>;
    }> = [];

    async publish<TPayload>(
        queue: QueueName,
        message: JobEnvelope<TPayload>,
    ): Promise<void> {
        this.published.push({
            queue,
            message: message as JobEnvelope<unknown>,
        });
    }

    async subscribe<TPayload>(
        _queue: QueueName,
        _handler: (message: QueueMessage<TPayload>) => Promise<void>,
        _options: SubscribeOptions,
    ): Promise<() => Promise<void>> {
        throw new Error("RecordingQueue does not support subscribe");
    }

    async close(): Promise<void> {}
}
