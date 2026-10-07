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
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-image-source";
import {
    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME,
    BOOTSTRAP_BACKFILL_RECOVERY_RETRY_MS,
    BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD,
    BOOTSTRAP_BACKFILL_STEP_RESULT_REASON,
    BOOTSTRAP_OPENSEA_STEP_RESULT_REASON,
    BootstrapBackfillExecutor,
    buildBootstrapBackfillDelegatedStepResult,
    buildBootstrapBackfillTerminalStepResult,
    type BootstrapBackfillCollectionPort,
    type BootstrapBackfillQueuePort,
    type BootstrapBackfillRunsPort,
    type BootstrapBackfillStepsPort,
    type BootstrapBackfillCoverageGapPort,
} from "../src/application/bootstrap-backfill-executor.js";
import { BOOTSTRAP_BACKFILL_PLAN_KIND } from "../src/application/bootstrap-backfill-plan.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import type { BootstrapRunDefinition } from "../src/ports/bootstrap-runs.js";

const TEST_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001";

describe("bootstrap backfill executor", () => {
    it("marks backfill skipped without catch-up when there are no post-anchor blocks", async () => {
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
                cleanup: expect.objectContaining({ deleted: false }),
            }),
        );
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
        expect(harness.succeededSteps).toEqual([]);
        expect(harness.resultUpdates).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.Backfill,
                result: buildBootstrapBackfillTerminalStepResult({
                    reason: BOOTSTRAP_BACKFILL_STEP_RESULT_REASON.NoPostAnchorBlocks,
                    liveBlock: 100,
                }),
            },
        ]);
        expect(harness.run.status).toBe(BOOTSTRAP_RUN_STATUS.Ownership);
        expect(harness.cleanupDeletedRows).toEqual(emptyCleanupDeletedRows());
        expect(harness.events.map((event) => event.eventCode)).toEqual([
            BOOTSTRAP_RUN_EVENT_CODE.OpenSeaSkipped,
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
            {
                chainId: 1,
                collectionId: 7,
                bootstrap: {
                    runId: 41,
                },
            },
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
        expect(harness.resultUpdates.at(-1)?.result).toEqual(
            buildBootstrapBackfillDelegatedStepResult({
                fromBlock: 101,
                toBlock: 105,
            }),
        );
        expect(harness.run.status).toBe(BOOTSTRAP_RUN_STATUS.Backfill);
        expect(harness.cleanupDeletedRows).toEqual(emptyCleanupDeletedRows());
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
        expect(harness.resultUpdates.at(-1)?.result).toEqual(
            expect.objectContaining({
                [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.FromBlock]: 101,
                [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.ToBlock]: 105,
                [BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.Recovery]:
                    expect.any(Object),
            }),
        );
    });

    it("reacquires a missing batch for a retained delegated range", async () => {
        const harness = createHarness({ syncedBlockCount: 0 });

        await harness.executor.checkProgress(checkInput());

        expect(harness.backfillRanges).toEqual([
            expect.objectContaining({
                chainId: 1,
                collectionId: 7,
                fromBlock: 104,
                toBlock: 105,
                batchSize: 2,
                recoveryId: expect.any(String),
            }),
        ]);
    });

    it("waits for one pending batch and retries missing coverage with a fresh identity after the delay", async () => {
        let now = 1000;
        const harness = createHarness({ now: () => now });
        await harness.executor.checkProgress(checkInput());
        await harness.executor.checkProgress(checkInput());
        expect(harness.backfillRanges).toHaveLength(1);

        now += BOOTSTRAP_BACKFILL_RECOVERY_RETRY_MS;
        await harness.executor.checkProgress(checkInput());
        expect(harness.backfillRanges).toHaveLength(2);
        expect(harness.backfillRanges[1].recoveryId).not.toBe(
            harness.backfillRanges[0].recoveryId,
        );
    });

    it("reuses the retained delivery after an uncertain publication instead of waiting or admitting a duplicate", async () => {
        let failed = false;
        const harness = createHarness({
            publish: async () => {
                if (!failed) {
                    failed = true;
                    throw new Error("Uncertain broker acknowledgement");
                }
            },
        });
        await expect(
            harness.executor.checkProgress(checkInput()),
        ).rejects.toThrow("Uncertain broker acknowledgement");
        await harness.executor.checkProgress(checkInput());
        expect(harness.backfillRanges).toHaveLength(2);
        expect(harness.backfillRanges[1]).toEqual(harness.backfillRanges[0]);
    });

    it("schedules the next missing batch immediately when the pending batch is covered", async () => {
        let covered = false;
        const harness = createHarness({
            findGap: (_chain, _collection, window) => {
                if (covered && window.fromBlock === 104) return null;
                return covered
                    ? { fromBlock: 102, toBlock: 103 }
                    : { fromBlock: 104, toBlock: 105 };
            },
        });
        await harness.executor.checkProgress(checkInput());
        covered = true;
        await harness.executor.checkProgress(checkInput());
        expect(
            harness.backfillRanges.map(({ fromBlock, toBlock }) => ({
                fromBlock,
                toBlock,
            })),
        ).toEqual([
            { fromBlock: 104, toBlock: 105 },
            { fromBlock: 102, toBlock: 103 },
        ]);
    });

    it("marks backfill complete and writes collection-live handoff state", async () => {
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
                cleanup: expect.objectContaining({ deleted: false }),
            }),
        );
        expect(harness.succeededSteps).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.Backfill,
                progress: { completed: 5, total: 5 },
            },
        ]);
        expect(harness.resultUpdates).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.Backfill,
                result: buildBootstrapBackfillTerminalStepResult({
                    fromBlock: 101,
                    toBlock: 105,
                    liveBlock: 105,
                }),
            },
        ]);
        expect(harness.run.status).toBe(BOOTSTRAP_RUN_STATUS.Backfill);
        expect(harness.cleanupDeletedRows).toEqual(emptyCleanupDeletedRows());
    });

    it("leaves cleanup to collection-live while the image-cache side lane is still pending", async () => {
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
                cleanup: expect.objectContaining({
                    deleted: false,
                }),
            }),
        );
        expect(harness.run.status).toBe(BOOTSTRAP_RUN_STATUS.Backfill);
        expect(harness.cleanupDeletedRows).toEqual(emptyCleanupDeletedRows());
    });

    it("does not delete best-effort metadata tasks before collection-live finalization", async () => {
        const harness = createHarness({
            syncedBlockCount: 5,
            run: buildRun({ status: BOOTSTRAP_RUN_STATUS.Backfill }),
            metadataCounts: taskCounts({ succeeded: 2, failedTerminal: 1 }),
            imageCacheCounts: cleanCounts(0),
            ownershipCounts: cleanCounts(3),
        });

        const result = await harness.executor.checkProgress(checkInput());

        expect(result).toEqual(
            expect.objectContaining({
                outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillCompleted,
                cleanup: expect.objectContaining({
                    deleted: false,
                }),
            }),
        );
        expect(harness.cleanupDeletedRows).toEqual(emptyCleanupDeletedRows());
    });
});

type Harness = {
    executor: BootstrapBackfillExecutor;
    run: BootstrapRunDefinition;
    events: Array<Parameters<BootstrapBackfillRunsPort["appendRunEvent"]>[0]>;
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
    resultUpdates: Array<{
        runId: number;
        stepKey: BootstrapStepKey;
        result: Record<string, unknown>;
    }>;
    backfillRanges: Array<
        Parameters<BootstrapBackfillQueuePort["scheduleBackfillRange"]>[0]
    >;
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
    headBlock?: number;
    syncedBlockCount?: number;
    run?: BootstrapRunDefinition;
    openseaSlug?: string | null;
    metadataCounts?: BootstrapTaskCounts;
    imageCacheCounts?: BootstrapTaskCounts;
    ownershipCounts?: BootstrapTaskCounts;
    collectionExtensionArtifactCounts?: BootstrapTaskCounts;
    now?: () => number;
    findGap?: BootstrapBackfillCoverageGapPort["findGap"];
    publish?: BootstrapBackfillQueuePort["scheduleBackfillRange"];
}): Harness {
    const run = input.run ?? buildRun({});
    const events: Harness["events"] = [];
    const openSeaPending: Harness["openSeaPending"] = [];
    const runningSteps: Harness["runningSteps"] = [];
    const succeededSteps: Harness["succeededSteps"] = [];
    const skippedSteps: Harness["skippedSteps"] = [];
    const progressUpdates: Harness["progressUpdates"] = [];
    const resultUpdates: Harness["resultUpdates"] = [];
    const backfillRanges: Harness["backfillRanges"] = [];
    const backfillChecks: Harness["backfillChecks"] = [];
    const openSeaSchedules: Harness["openSeaSchedules"] = [];
    const cleanupDeletedRows = emptyCleanupDeletedRows();
    let resultJson: string | null = null;
    const runsPort: BootstrapBackfillRunsPort = {
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
        getStep: () => ({ resultJson }),
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
        updateStepResult: (runId, stepKey, result) => {
            resultJson = JSON.stringify(result);
            resultUpdates.push({ runId, stepKey, result });
        },
    };
    const collectionPort: BootstrapBackfillCollectionPort = {
        getCollection: (chainId, collectionId) =>
            chainId === run.chainId && collectionId === run.collectionId
                ? { openseaSlug: input.openseaSlug ?? null }
                : null,
        markOpenSeaPending: (chainId, collectionId) => {
            openSeaPending.push({ chainId, collectionId });
            return true;
        },
    };
    const queuePort: BootstrapBackfillQueuePort = {
        scheduleBackfillRange: async (request) => {
            backfillRanges.push(request);
            await input.publish?.(request);
        },
        scheduleBackfillCheck: async (request) => {
            backfillChecks.push(request);
        },
        scheduleOpenSeaBootstrap: async (request) => {
            openSeaSchedules.push(request);
        },
    };
    const executor = new BootstrapBackfillExecutor(
        {
            getBlockNumber: async () => input.headBlock ?? 105,
        },
        {
            countCollectionSyncedBlocksInRange: () =>
                input.syncedBlockCount ?? 0,
        },
        collectionPort,
        runsPort,
        stepsPort,
        queuePort,
        {
            findGap:
                input.findGap ??
                ((_chainId, _collectionId, window, batchSize) => ({
                    fromBlock: Math.max(
                        window.fromBlock,
                        window.toBlock - batchSize + 1,
                    ),
                    toBlock: window.toBlock,
                })),
        },
        input.now,
    );

    return {
        executor,
        run,
        events,
        openSeaPending,
        runningSteps,
        succeededSteps,
        skippedSteps,
        progressUpdates,
        resultUpdates,
        backfillRanges,
        backfillChecks,
        openSeaSchedules,
        cleanupDeletedRows,
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
        backfillBatchSize: 2,
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
        imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
        animationSourceField: null,
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

function emptyCleanupDeletedRows(): CleanupDeletedRows {
    return {
        metadataTasks: 0,
        imageCacheTasks: 0,
        ownershipTasks: 0,
        ownershipSnapshotRows: 0,
        collectionExtensionArtifactTasks: 0,
    };
}
