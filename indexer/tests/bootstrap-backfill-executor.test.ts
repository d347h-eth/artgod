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
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-image-source";
import {
    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME,
    BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD,
    BOOTSTRAP_BACKFILL_STEP_RESULT_REASON,
    BootstrapBackfillExecutor,
    buildBootstrapBackfillDelegatedStepResult,
    buildBootstrapBackfillTerminalStepResult,
    type BootstrapBackfillQueuePort,
    type BootstrapBackfillRunsPort,
    type BootstrapBackfillStepsPort,
} from "../src/application/bootstrap-backfill-executor.js";
import { BOOTSTRAP_BACKFILL_PLAN_KIND } from "../src/application/bootstrap-backfill-plan.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import type { BootstrapRunDefinition } from "../src/ports/bootstrap-runs.js";
import type { BootstrapAppliedProgressPort } from "../src/application/bootstrap-applied-progress.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import { publishBootstrapBackfillRange } from "../src/infra/bootstrap/backfill-range-publisher.js";
import { BACKFILL_SOURCE } from "../src/domain/sync-jobs.js";

const TEST_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001";

describe("bootstrap backfill executor", () => {
    it("publishes one wakeup for a large retained catch-up range", async () => {
        const deliveries: unknown[] = [];
        await publishBootstrapBackfillRange(
            {
                publish: async (_queue, job) => {
                    deliveries.push(job);
                },
            },
            {
                chainId: 1,
                collectionId: 7,
                fromBlock: 101,
                toBlock: 1_000_000,
            },
        );
        expect(deliveries).toEqual([
            expect.objectContaining({
                collectionId: 7,
                payload: expect.objectContaining({
                    fromBlock: 101,
                    toBlock: 1_000_000,
                    source: BACKFILL_SOURCE.BootstrapCatchup,
                }),
            }),
        ]);
    });

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
                    fromBlock: 101,
                    toBlock: 100,
                    liveBlock: 100,
                }),
            },
        ]);
        expect(harness.run.status).toBe(BOOTSTRAP_RUN_STATUS.Ownership);
        expect(harness.cleanupDeletedRows).toEqual(emptyCleanupDeletedRows());
        expect(harness.events).toEqual([]);
    });

    it("queues catch-up backfill and a completion check when head is post-anchor", async () => {
        const harness = createHarness({
            headBlock: 105,
            run: buildRun({ status: BOOTSTRAP_RUN_STATUS.Ownership }),
        });

        const result = await harness.executor.scheduleAfterSnapshot(
            scheduleInput({
                anchorBlock: 100,
            }),
        );

        expect(result.outcome).toBe(
            BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillQueued,
        );
        expect(harness.backfillRanges).toEqual([
            {
                chainId: 1,
                collectionId: 7,
                fromBlock: 101,
                toBlock: 105,
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
            appliedBlock: 102,
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
        expect(harness.backfillRanges).toEqual([]);
    });

    it("retains the original finishing range when a wakeup publication fails", async () => {
        let headReads = 0;
        const harness = createHarness({
            getHead: async () => {
                headReads++;
                return 105;
            },
            publish: async () => {
                throw new Error("Lost wakeup");
            },
        });
        await expect(
            harness.executor.executeStep(scheduleInput({ anchorBlock: 100 })),
        ).rejects.toThrow("Lost wakeup");
        const result = await harness.executor.executeStep(
            scheduleInput({ anchorBlock: 100 }),
        );
        expect(result.outcome).toBe(
            BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete,
        );
        expect(headReads).toBe(1);
        expect(harness.backfillRanges).toHaveLength(1);
        expect(harness.backfillChecks).toHaveLength(1);
    });

    it("waits for an accepted base even with no post-anchor blocks", async () => {
        const harness = createHarness({ headBlock: 100, appliedBlock: null });
        const scheduled = await harness.executor.executeStep(
            scheduleInput({ anchorBlock: 100 }),
        );
        const checked = await harness.executor.executeStep(
            scheduleInput({ anchorBlock: 100 }),
        );
        expect(scheduled.outcome).toBe(
            BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillQueued,
        );
        expect(checked.outcome).toBe(
            BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete,
        );
        expect(harness.backfillRanges).toEqual([]);
        expect(harness.succeededSteps).toEqual([]);
        expect(
            harness.skippedSteps.some(
                (step) => step.stepKey === BOOTSTRAP_STEP_KEY.Backfill,
            ),
        ).toBe(false);
    });

    it("does not complete a range against a different run anchor", async () => {
        const harness = createHarness({ appliedBlock: 105 });
        const result = await harness.executor.checkProgress({
            ...checkInput(),
            anchorHash: "other-base",
        });
        expect(result.outcome).toBe(
            BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete,
        );
        expect(result.synced).toBe(0);
    });

    it("marks backfill complete and writes collection-live handoff state", async () => {
        const harness = createHarness({
            appliedBlock: 105,
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
            appliedBlock: 105,
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
            appliedBlock: 105,
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
    appliedBlock?: number | null;
    progress?: BootstrapAppliedProgressPort;
    getHead?: () => Promise<number>;
    run?: BootstrapRunDefinition;
    metadataCounts?: BootstrapTaskCounts;
    imageCacheCounts?: BootstrapTaskCounts;
    ownershipCounts?: BootstrapTaskCounts;
    collectionExtensionArtifactCounts?: BootstrapTaskCounts;
    publish?: BootstrapBackfillQueuePort["scheduleBackfillRange"];
}): Harness {
    const run = input.run ?? buildRun({});
    const events: Harness["events"] = [];
    const runningSteps: Harness["runningSteps"] = [];
    const succeededSteps: Harness["succeededSteps"] = [];
    const skippedSteps: Harness["skippedSteps"] = [];
    const progressUpdates: Harness["progressUpdates"] = [];
    const resultUpdates: Harness["resultUpdates"] = [];
    const backfillRanges: Harness["backfillRanges"] = [];
    const backfillChecks: Harness["backfillChecks"] = [];
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
        markStepSucceeded: (runId, stepKey, progress, result) => {
            if (result) {
                resultJson = JSON.stringify(result);
                resultUpdates.push({ runId, stepKey, result });
            }
            succeededSteps.push(
                progress === undefined
                    ? { runId, stepKey }
                    : { runId, stepKey, progress },
            );
        },
        markStepSkipped: (runId, stepKey, reason, result) => {
            if (result) {
                resultJson = JSON.stringify(result);
                resultUpdates.push({ runId, stepKey, result });
            }
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
    const queuePort: BootstrapBackfillQueuePort = {
        scheduleBackfillRange: async (request) => {
            backfillRanges.push(request);
            await input.publish?.(request);
        },
        scheduleBackfillCheck: async (request) => {
            backfillChecks.push(request);
        },
    };
    const executor = new BootstrapBackfillExecutor(
        {
            getBlockNumber:
                input.getHead ?? (async () => input.headBlock ?? 105),
        },
        input.progress ?? {
            collectionProgress: () =>
                input.appliedBlock === null
                    ? null
                    : {
                          collectionId: run.collectionId,
                          checkpoint: { chainId: run.chainId, revision: 0 },
                          anchor: {
                              ...syncBlockFixture(100),
                              hash: run.anchorBlockHash!,
                          },
                          applied: syncBlockFixture(input.appliedBlock ?? 100),
                      },
            validationCheckpoint: () =>
                input.appliedBlock === null
                    ? null
                    : {
                          chainId: run.chainId,
                          revision: 0,
                          collectionId: run.collectionId,
                          block: syncBlockFixture(input.appliedBlock ?? 100),
                      },
        },
        runsPort,
        stepsPort,
        queuePort,
    );

    return {
        executor,
        run,
        events,
        runningSteps,
        succeededSteps,
        skippedSteps,
        progressUpdates,
        resultUpdates,
        backfillRanges,
        backfillChecks,
        cleanupDeletedRows,
    };
}

function scheduleInput(input: { anchorBlock: number }) {
    return {
        chainId: 1,
        runId: 41,
        collectionId: 7,
        address: TEST_CONTRACT_ADDRESS,
        anchorBlock: input.anchorBlock,
        anchorHash: buildRun({}).anchorBlockHash!,
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
        anchorBlock: 100,
        anchorHash: buildRun({}).anchorBlockHash!,
        fromBlock: 101,
        toBlock: 105,
        traceId: "trace-1",
        sourceJobId: "job-1",
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
