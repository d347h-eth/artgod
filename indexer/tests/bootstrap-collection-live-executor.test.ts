import { describe, expect, it } from "vitest";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    type BootstrapRunStatus,
    type BootstrapTaskCounts,
} from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import {
    BOOTSTRAP_COLLECTION_LIVE_EXECUTOR_OUTCOME,
    BootstrapCollectionLiveExecutor,
    type BootstrapCollectionLiveCollectionPort,
    type BootstrapCollectionLiveQueuePort,
    type BootstrapCollectionLiveRunsPort,
    type BootstrapCollectionLiveStepsPort,
    type BootstrapCollectionLiveTemporaryDataPort,
} from "../src/application/bootstrap-collection-live-executor.js";
import { buildBootstrapBackfillTerminalStepResult } from "../src/application/bootstrap-backfill-executor.js";
import {
    METADATA_STATS_RECOMPUTE_REASON,
    type MetadataStatsRecomputePayload,
} from "../src/domain/domain-jobs.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import type { BootstrapRunDefinition } from "../src/ports/bootstrap-runs.js";
import type { BootstrapStepRecord } from "../src/ports/bootstrap-steps.js";

const TEST_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001";

describe("bootstrap collection-live executor", () => {
    it("marks the collection live and deletes settled blocking task rows", async () => {
        const harness = createHarness({
            metadataCounts: cleanCounts(3),
            imageCacheCounts: taskCounts({ pending: 1, succeeded: 2 }),
            ownershipCounts: cleanCounts(3),
        });

        const result = await harness.executor.complete({
            run: harness.run,
            step: collectionLiveStep(harness.run.runId),
            traceId: "trace-1",
            sourceJobId: "job-1",
        });

        expect(result).toEqual(
            expect.objectContaining({
                outcome: BOOTSTRAP_COLLECTION_LIVE_EXECUTOR_OUTCOME.Completed,
                liveBlock: 105,
                cleanup: expect.objectContaining({
                    deleted: true,
                    metadataTasks: 3,
                    imageCacheTasks: 0,
                    ownershipTasks: 3,
                    ownershipSnapshotRows: 3,
                }),
            }),
        );
        expect(harness.collectionFinishes).toEqual([
            { chainId: 1, collectionId: 7, lastSyncedBlock: 105 },
        ]);
        expect(harness.succeededSteps).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.CollectionLive,
            },
        ]);
        expect(harness.run.status).toBe(BOOTSTRAP_RUN_STATUS.Completed);
        expect(harness.cleanupDeletedRows).toEqual({
            metadataTasks: 3,
            imageCacheTasks: 0,
            ownershipTasks: 3,
            ownershipSnapshotRows: 3,
            collectionExtensionArtifactTasks: 0,
        });
        expect(harness.statsRecomputeRequests).toEqual([
            {
                payload: {
                    chainId: 1,
                    collectionId: 7,
                    reason: METADATA_STATS_RECOMPUTE_REASON.BootstrapFinalized,
                    sourceJobId: "job-1",
                },
                traceId: "trace-1",
            },
        ]);
        expect(harness.events.map((event) => event.eventCode)).toEqual([
            BOOTSTRAP_RUN_EVENT_CODE.RunCompleted,
        ]);
    });

    it("retains terminal best-effort metadata failures while deleting succeeded rows", async () => {
        const harness = createHarness({
            metadataCounts: taskCounts({ succeeded: 2, failedTerminal: 1 }),
            imageCacheCounts: cleanCounts(0),
            ownershipCounts: cleanCounts(3),
        });

        const result = await harness.executor.complete({
            run: harness.run,
            step: collectionLiveStep(harness.run.runId),
            traceId: "trace-1",
            sourceJobId: "job-1",
        });

        expect(result.cleanup).toEqual(
            expect.objectContaining({
                deleted: true,
                metadataTasks: 2,
                imageCacheTasks: 0,
                ownershipTasks: 3,
            }),
        );
        expect(harness.cleanupDeletedRows).toEqual({
            metadataTasks: 2,
            imageCacheTasks: 0,
            ownershipTasks: 3,
            ownershipSnapshotRows: 3,
            collectionExtensionArtifactTasks: 0,
        });
    });
});

type Harness = {
    executor: BootstrapCollectionLiveExecutor;
    run: BootstrapRunDefinition;
    events: Array<Parameters<BootstrapCollectionLiveRunsPort["appendRunEvent"]>[0]>;
    collectionFinishes: Array<{
        chainId: number;
        collectionId: number;
        lastSyncedBlock: number;
    }>;
    succeededSteps: Array<{
        runId: number;
        stepKey: typeof BOOTSTRAP_STEP_KEY.CollectionLive;
    }>;
    statsRecomputeRequests: Array<{
        payload: MetadataStatsRecomputePayload;
        traceId: string;
    }>;
    cleanupDeletedRows: CleanupDeletedRows;
};

type CleanupDeletedRows = {
    metadataTasks: number;
    imageCacheTasks: number;
    ownershipTasks: number;
    ownershipSnapshotRows: number;
    collectionExtensionArtifactTasks: number;
};

function createHarness(input: {
    metadataCounts: BootstrapTaskCounts;
    imageCacheCounts: BootstrapTaskCounts;
    ownershipCounts: BootstrapTaskCounts;
}): Harness {
    const run = buildRun({ status: BOOTSTRAP_RUN_STATUS.Backfill });
    const backfillStep = backfillStepWithLiveBlock(run.runId, 105);
    const events: Harness["events"] = [];
    const collectionFinishes: Harness["collectionFinishes"] = [];
    const succeededSteps: Harness["succeededSteps"] = [];
    const statsRecomputeRequests: Harness["statsRecomputeRequests"] = [];
    let metadataCounts = input.metadataCounts;
    let imageCacheCounts = input.imageCacheCounts;
    let ownershipCounts = input.ownershipCounts;
    let ownershipSnapshotRows = ownershipCounts.succeeded;
    let collectionExtensionArtifactCounts = cleanCounts(0);
    const cleanupDeletedRows = emptyCleanupDeletedRows();

    const collectionPort: BootstrapCollectionLiveCollectionPort = {
        markBootstrapFinished: (chainId, collectionId, lastSyncedBlock) => {
            if (chainId !== run.chainId || collectionId !== run.collectionId) {
                return false;
            }
            collectionFinishes.push({ chainId, collectionId, lastSyncedBlock });
            return true;
        },
    };
    const runsPort: BootstrapCollectionLiveRunsPort = {
        getRun: (runId) => (runId === run.runId ? run : null),
        updateRunStatus: (runId, status) => {
            if (runId === run.runId) {
                run.status = status;
            }
        },
        appendRunEvent: (event) => {
            events.push(event);
        },
    };
    const stepsPort: BootstrapCollectionLiveStepsPort = {
        getStep: (runId, stepKey) =>
            runId === run.runId && stepKey === BOOTSTRAP_STEP_KEY.Backfill
                ? backfillStep
                : null,
        markStepSucceeded: (runId, stepKey) => {
            succeededSteps.push({ runId, stepKey });
        },
        markStepFailedTerminal: () => {},
    };
    const temporaryDataPort: BootstrapCollectionLiveTemporaryDataPort = {
        deleteSnapshotRows: () => {
            const deleted = ownershipSnapshotRows;
            cleanupDeletedRows.ownershipSnapshotRows += deleted;
            ownershipSnapshotRows = 0;
            return deleted;
        },
        deleteSucceededMetadataTasks: () => {
            const deleted = metadataCounts.succeeded;
            cleanupDeletedRows.metadataTasks += deleted;
            metadataCounts = removeSucceededTasks(metadataCounts);
            return deleted;
        },
        deleteSucceededImageCacheTasks: () => {
            const deleted = imageCacheCounts.succeeded;
            cleanupDeletedRows.imageCacheTasks += deleted;
            imageCacheCounts = removeSucceededTasks(imageCacheCounts);
            return deleted;
        },
        deleteSucceededOwnershipTasks: () => {
            const deleted = ownershipCounts.succeeded;
            cleanupDeletedRows.ownershipTasks += deleted;
            ownershipCounts = removeSucceededTasks(ownershipCounts);
            return deleted;
        },
        deleteSucceededCollectionExtensionArtifactTasks: () => {
            const deleted = collectionExtensionArtifactCounts.succeeded;
            cleanupDeletedRows.collectionExtensionArtifactTasks += deleted;
            collectionExtensionArtifactCounts = removeSucceededTasks(
                collectionExtensionArtifactCounts,
            );
            return deleted;
        },
        getMetadataTaskCounts: () => metadataCounts,
        getImageCacheTaskCounts: () => imageCacheCounts,
        getOwnershipTaskCounts: () => ownershipCounts,
        getCollectionExtensionArtifactTaskCounts: () =>
            collectionExtensionArtifactCounts,
    };
    const queuePort: BootstrapCollectionLiveQueuePort = {
        publishMetadataStatsRecompute: async (request) => {
            statsRecomputeRequests.push(request);
        },
    };

    return {
        executor: new BootstrapCollectionLiveExecutor(
            collectionPort,
            runsPort,
            stepsPort,
            temporaryDataPort,
            queuePort,
        ),
        run,
        events,
        collectionFinishes,
        succeededSteps,
        statsRecomputeRequests,
        cleanupDeletedRows,
    };
}

function collectionLiveStep(runId: number): BootstrapStepRecord {
    return step(runId, BOOTSTRAP_STEP_KEY.CollectionLive, null);
}

function backfillStepWithLiveBlock(
    runId: number,
    liveBlock: number,
): BootstrapStepRecord {
    return step(
        runId,
        BOOTSTRAP_STEP_KEY.Backfill,
        JSON.stringify(
            buildBootstrapBackfillTerminalStepResult({
                fromBlock: 101,
                toBlock: liveBlock,
                liveBlock,
            }),
        ),
    );
}

function step(
    runId: number,
    stepKey: BootstrapStepRecord["stepKey"],
    resultJson: string | null,
): BootstrapStepRecord {
    return {
        runId,
        stepKey,
        status: BOOTSTRAP_STEP_STATUS.Ready,
        blocking: true,
        dependsOn: [],
        nextAttemptAt: 0,
        leaseOwner: null,
        leaseUntil: null,
        progressCompleted: 0,
        progressTotal: null,
        resultJson,
        attempts: 0,
        lastError: null,
    };
}

function buildRun(input: {
    status?: BootstrapRunStatus;
}): BootstrapRunDefinition {
    return {
        runId: 41,
        chainId: 1,
        collectionId: 7,
        requestSlug: "milady-by-remilia-corporation",
        requestAddress: TEST_CONTRACT_ADDRESS,
        requestStandard: COLLECTION_STANDARD.Erc721,
        requestExtensionKey: null,
        metadataMode: BOOTSTRAP_METADATA_MODE.BestEffort,
        enumerationMode: BOOTSTRAP_ENUMERATION_MODE.Enumerable,
        manualTokenIdsJson: null,
        manualRangeStartTokenId: null,
        manualRangeTotalSupply: null,
        imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
        imageCacheMaxDimension: 1024,
        deploymentBlock: null,
        status: input.status ?? BOOTSTRAP_RUN_STATUS.Backfill,
        anchorBlock: 100,
        anchorBlockHash:
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        anchorBlockTimestamp: 1726000000,
    };
}

function cleanCounts(total: number): BootstrapTaskCounts {
    return taskCounts({ succeeded: total });
}

function taskCounts(input: {
    pending?: number;
    retry?: number;
    succeeded?: number;
    failedTerminal?: number;
}): BootstrapTaskCounts {
    const pending = input.pending ?? 0;
    const retry = input.retry ?? 0;
    const succeeded = input.succeeded ?? 0;
    const failedTerminal = input.failedTerminal ?? 0;
    return {
        pending,
        retry,
        succeeded,
        failedTerminal,
        total: pending + retry + succeeded + failedTerminal,
    };
}

function removeSucceededTasks(counts: BootstrapTaskCounts): BootstrapTaskCounts {
    return {
        ...counts,
        succeeded: 0,
        total: counts.total - counts.succeeded,
    };
}

function emptyCleanupDeletedRows(): CleanupDeletedRows {
    return {
        metadataTasks: 0,
        imageCacheTasks: 0,
        ownershipTasks: 0,
        ownershipSnapshotRows: 0,
        collectionExtensionArtifactTasks: 0,
    };
}
