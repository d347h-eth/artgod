import { describe, expect, it } from "vitest";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    type BootstrapRunStatus,
    type BootstrapStepKey,
    type BootstrapTaskCounts,
} from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import {
    OPENSEA_INTEGRATION_MODE,
    type OpenSeaIntegrationStatus,
} from "@artgod/shared/config/opensea-integration";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import {
    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME,
    BOOTSTRAP_BACKFILL_STEP_RESULT_REASON,
    BOOTSTRAP_OPENSEA_STEP_RESULT_REASON,
    BootstrapBackfillExecutor,
    type BootstrapBackfillCollectionPort,
    type BootstrapBackfillQueuePort,
    type BootstrapBackfillRunsPort,
    type BootstrapBackfillStepsPort,
    type BootstrapBackfillTemporaryDataPort,
} from "../src/application/bootstrap-backfill-executor.js";
import { BOOTSTRAP_BACKFILL_PLAN_KIND } from "../src/application/bootstrap-backfill-plan.js";
import {
    METADATA_STATS_RECOMPUTE_REASON,
    type MetadataStatsRecomputePayload,
} from "../src/domain/domain-jobs.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import type { BootstrapRunDefinition } from "../src/ports/bootstrap-runs.js";

const TEST_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001";

describe("bootstrap backfill executor", () => {
    it("marks the collection live without catch-up when there are no post-anchor blocks", async () => {
        const harness = createHarness({
            headBlock: 100,
            run: buildRun({ status: BOOTSTRAP_RUN_STATUS.Ownership }),
            metadataCounts: cleanCounts(3),
            imageCacheCounts: cleanCounts(0),
            ownershipCounts: cleanCounts(3),
        });

        const result = await harness.executor.scheduleAfterSnapshot(
            scheduleInput({ anchorBlock: 100 }),
        );

        expect(result).toEqual(
            expect.objectContaining({
                outcome:
                    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.CompletedWithoutBackfill,
                fromBlock: 101,
                headBlock: 100,
                plan: {
                    kind: BOOTSTRAP_BACKFILL_PLAN_KIND.NoPostAnchorBlocks,
                    fromBlock: 101,
                    headBlock: 100,
                },
                cleanup: expect.objectContaining({ deleted: true }),
            }),
        );
        expect(harness.collectionFinishes).toEqual([
            { chainId: 1, collectionId: 7, lastSyncedBlock: 100 },
        ]);
        expect(harness.skippedSteps).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
                reason: BOOTSTRAP_OPENSEA_STEP_RESULT_REASON.IntegrationDisabled,
            },
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
                reason: BOOTSTRAP_OPENSEA_STEP_RESULT_REASON.IntegrationDisabled,
            },
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.OpenSeaReady,
                reason: BOOTSTRAP_OPENSEA_STEP_RESULT_REASON.IntegrationDisabled,
            },
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.Backfill,
                reason: BOOTSTRAP_BACKFILL_STEP_RESULT_REASON.NoPostAnchorBlocks,
            },
        ]);
        expect(harness.succeededSteps).toEqual([
            { runId: 41, stepKey: BOOTSTRAP_STEP_KEY.CollectionLive },
        ]);
        expect(harness.run.status).toBe(BOOTSTRAP_RUN_STATUS.Completed);
        expect(harness.deletedRunIds).toEqual([41]);
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
            BOOTSTRAP_RUN_EVENT_CODE.OpenSeaSkipped,
            BOOTSTRAP_RUN_EVENT_CODE.RunCompleted,
        ]);
    });

    it("queues catch-up backfill and a completion check when head is post-anchor", async () => {
        const harness = createHarness({
            headBlock: 105,
            run: buildRun({ status: BOOTSTRAP_RUN_STATUS.Ownership }),
            openseaSlug: "milady-by-remilia-corporation",
        });

        const result = await harness.executor.scheduleAfterSnapshot(
            scheduleInput({
                anchorBlock: 100,
                openSeaIntegration: enabledOpenSeaIntegration(),
            }),
        );

        expect(result.outcome).toBe(
            BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillQueued,
        );
        expect(harness.openSeaPending).toEqual([
            { chainId: 1, collectionId: 7 },
        ]);
        expect(harness.openSeaSchedules).toEqual([
            { chainId: 1, runId: 41, collectionId: 7 },
        ]);
        expect(harness.backfillRanges).toEqual([
            {
                chainId: 1,
                collectionId: 7,
                fromBlock: 101,
                toBlock: 105,
                batchSize: 2,
            },
        ]);
        expect(harness.backfillChecks).toEqual([
            {
                chainId: 1,
                runId: 41,
                collectionId: 7,
                address: TEST_CONTRACT_ADDRESS,
                fromBlock: 101,
                toBlock: 105,
            },
        ]);
        expect(harness.progressUpdates).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.Backfill,
                progress: { completed: 0, total: 5 },
            },
        ]);
        expect(harness.run.status).toBe(BOOTSTRAP_RUN_STATUS.Backfill);
        expect(harness.deletedRunIds).toEqual([]);
    });

    it("requeues an incomplete backfill check with current progress", async () => {
        const harness = createHarness({
            syncedBlockCount: 2,
            run: buildRun({ status: BOOTSTRAP_RUN_STATUS.Backfill }),
        });

        const result = await harness.executor.checkProgress(checkInput());

        expect(result.outcome).toBe(
            BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete,
        );
        expect(result).toEqual(
            expect.objectContaining({
                expected: 5,
                synced: 2,
            }),
        );
        expect(harness.progressUpdates).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.Backfill,
                progress: { completed: 2, total: 5 },
            },
        ]);
        expect(harness.backfillChecks).toEqual([
            {
                chainId: 1,
                runId: 41,
                collectionId: 7,
                address: TEST_CONTRACT_ADDRESS,
                fromBlock: 101,
                toBlock: 105,
            },
        ]);
    });

    it("marks live and cleans temporary data when catch-up is complete", async () => {
        const harness = createHarness({
            syncedBlockCount: 5,
            run: buildRun({ status: BOOTSTRAP_RUN_STATUS.Backfill }),
            metadataCounts: cleanCounts(3),
            imageCacheCounts: cleanCounts(3),
            ownershipCounts: cleanCounts(3),
        });

        const result = await harness.executor.checkProgress(checkInput());

        expect(result).toEqual(
            expect.objectContaining({
                outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillCompleted,
                expected: 5,
                synced: 5,
                cleanup: expect.objectContaining({ deleted: true }),
            }),
        );
        expect(harness.collectionFinishes).toEqual([
            { chainId: 1, collectionId: 7, lastSyncedBlock: 105 },
        ]);
        expect(harness.succeededSteps).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.Backfill,
                progress: { completed: 5, total: 5 },
            },
            { runId: 41, stepKey: BOOTSTRAP_STEP_KEY.CollectionLive },
        ]);
        expect(harness.run.status).toBe(BOOTSTRAP_RUN_STATUS.Completed);
        expect(harness.deletedRunIds).toEqual([41]);
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
    });

    it("keeps temporary data when the image-cache side lane is still pending", async () => {
        const harness = createHarness({
            syncedBlockCount: 5,
            run: buildRun({ status: BOOTSTRAP_RUN_STATUS.Backfill }),
            metadataCounts: cleanCounts(3),
            imageCacheCounts: taskCounts({ pending: 1, succeeded: 2 }),
            ownershipCounts: cleanCounts(3),
        });

        const result = await harness.executor.checkProgress(checkInput());

        expect(result).toEqual(
            expect.objectContaining({
                outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillCompleted,
                cleanup: { deleted: false },
            }),
        );
        expect(harness.run.status).toBe(BOOTSTRAP_RUN_STATUS.Completed);
        expect(harness.deletedRunIds).toEqual([]);
    });
});

type Harness = {
    executor: BootstrapBackfillExecutor;
    run: BootstrapRunDefinition;
    events: Array<Parameters<BootstrapBackfillRunsPort["appendRunEvent"]>[0]>;
    collectionFinishes: Array<{
        chainId: number;
        collectionId: number;
        lastSyncedBlock: number;
    }>;
    openSeaPending: Array<{ chainId: number; collectionId: number }>;
    runningSteps: Array<{ runId: number; stepKey: BootstrapStepKey }>;
    succeededSteps: Array<{
        runId: number;
        stepKey: BootstrapStepKey;
        progress?: { completed: number; total: number | null };
    }>;
    skippedSteps: Array<{
        runId: number;
        stepKey: BootstrapStepKey;
        reason: string;
    }>;
    progressUpdates: Array<{
        runId: number;
        stepKey: BootstrapStepKey;
        progress: { completed: number; total: number | null };
    }>;
    backfillRanges: Array<{
        chainId: number;
        collectionId: number;
        fromBlock: number;
        toBlock: number;
        batchSize: number;
    }>;
    backfillChecks: Array<{
        chainId: number;
        runId: number;
        collectionId: number;
        address: string;
        fromBlock: number;
        toBlock: number;
    }>;
    openSeaSchedules: Array<{
        chainId: number;
        runId: number;
        collectionId: number;
    }>;
    statsRecomputeRequests: Array<{
        payload: MetadataStatsRecomputePayload;
        traceId: string;
    }>;
    deletedRunIds: number[];
};

function createHarness(input: {
    headBlock?: number;
    syncedBlockCount?: number;
    run?: BootstrapRunDefinition;
    openseaSlug?: string | null;
    metadataCounts?: BootstrapTaskCounts;
    imageCacheCounts?: BootstrapTaskCounts;
    ownershipCounts?: BootstrapTaskCounts;
}): Harness {
    const run = input.run ?? buildRun({});
    const events: Harness["events"] = [];
    const collectionFinishes: Harness["collectionFinishes"] = [];
    const openSeaPending: Harness["openSeaPending"] = [];
    const runningSteps: Harness["runningSteps"] = [];
    const succeededSteps: Harness["succeededSteps"] = [];
    const skippedSteps: Harness["skippedSteps"] = [];
    const progressUpdates: Harness["progressUpdates"] = [];
    const backfillRanges: Harness["backfillRanges"] = [];
    const backfillChecks: Harness["backfillChecks"] = [];
    const openSeaSchedules: Harness["openSeaSchedules"] = [];
    const statsRecomputeRequests: Harness["statsRecomputeRequests"] = [];
    const deletedRunIds: number[] = [];
    const runsPort: BootstrapBackfillRunsPort = {
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
    const stepsPort: BootstrapBackfillStepsPort = {
        markStepRunning: (runId, stepKey) => {
            runningSteps.push({ runId, stepKey });
        },
        markStepSucceeded: (runId, stepKey, progress) => {
            succeededSteps.push(
                progress === undefined
                    ? { runId, stepKey }
                    : { runId, stepKey, progress },
            );
        },
        markStepSkipped: (runId, stepKey, reason) => {
            skippedSteps.push({ runId, stepKey, reason });
        },
        updateStepProgress: (runId, stepKey, progress) => {
            progressUpdates.push({ runId, stepKey, progress });
        },
    };
    const collectionPort: BootstrapBackfillCollectionPort = {
        getCollection: (chainId, collectionId) =>
            chainId === run.chainId && collectionId === run.collectionId
                ? { openseaSlug: input.openseaSlug ?? null }
                : null,
        markBootstrapFinished: (chainId, collectionId, lastSyncedBlock) => {
            if (chainId !== run.chainId || collectionId !== run.collectionId) {
                return false;
            }
            collectionFinishes.push({ chainId, collectionId, lastSyncedBlock });
            return true;
        },
        markOpenSeaPending: (chainId, collectionId) => {
            openSeaPending.push({ chainId, collectionId });
            return true;
        },
    };
    const temporaryDataPort: BootstrapBackfillTemporaryDataPort = {
        deleteRunTemporaryData: (runId) => {
            deletedRunIds.push(runId);
        },
        getMetadataTaskCounts: () => input.metadataCounts ?? cleanCounts(0),
        getImageCacheTaskCounts: () => input.imageCacheCounts ?? cleanCounts(0),
        getOwnershipTaskCounts: () => input.ownershipCounts ?? cleanCounts(0),
    };
    const queuePort: BootstrapBackfillQueuePort = {
        scheduleBackfillRange: async (request) => {
            backfillRanges.push(request);
        },
        scheduleBackfillCheck: async (request) => {
            backfillChecks.push(request);
        },
        scheduleOpenSeaBootstrap: async (request) => {
            openSeaSchedules.push(request);
        },
        publishMetadataStatsRecompute: async (request) => {
            statsRecomputeRequests.push(request);
        },
    };
    const executor = new BootstrapBackfillExecutor(
        {
            getBlockNumber: async () => input.headBlock ?? 105,
        },
        {
            countCollectionSyncedBlocksInRange: () => input.syncedBlockCount ?? 0,
        },
        collectionPort,
        runsPort,
        stepsPort,
        temporaryDataPort,
        queuePort,
    );

    return {
        executor,
        run,
        events,
        collectionFinishes,
        openSeaPending,
        runningSteps,
        succeededSteps,
        skippedSteps,
        progressUpdates,
        backfillRanges,
        backfillChecks,
        openSeaSchedules,
        statsRecomputeRequests,
        deletedRunIds,
    };
}

function scheduleInput(input: {
    anchorBlock: number;
    openSeaIntegration?: OpenSeaIntegrationStatus;
}) {
    return {
        chainId: 1,
        runId: 41,
        collectionId: 7,
        address: TEST_CONTRACT_ADDRESS,
        anchorBlock: input.anchorBlock,
        backfillBatchSize: 2,
        openSeaIntegration:
            input.openSeaIntegration ?? disabledOpenSeaIntegration(),
        traceId: "trace-1",
        sourceJobId: "job-1",
    };
}

function checkInput() {
    return {
        chainId: 1,
        runId: 41,
        collectionId: 7,
        address: TEST_CONTRACT_ADDRESS,
        fromBlock: 101,
        toBlock: 105,
        traceId: "trace-1",
        sourceJobId: "job-1",
    };
}

function disabledOpenSeaIntegration(): OpenSeaIntegrationStatus {
    return {
        enabled: false,
        mode: OPENSEA_INTEGRATION_MODE.Disabled,
        reason: "disabled in test",
        missingKeys: [],
        requiredKeys: [],
    };
}

function enabledOpenSeaIntegration(): OpenSeaIntegrationStatus {
    return {
        enabled: true,
        mode: OPENSEA_INTEGRATION_MODE.Enabled,
        reason: null,
        missingKeys: [],
        requiredKeys: [],
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
        status: input.status ?? BOOTSTRAP_RUN_STATUS.Ownership,
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
