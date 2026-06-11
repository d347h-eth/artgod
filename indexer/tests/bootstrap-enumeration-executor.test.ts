import { describe, expect, it } from "vitest";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    type BootstrapRunStatus,
    type BootstrapStepKey,
} from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import {
    BOOTSTRAP_ENUMERATION_EXECUTOR_OUTCOME,
    BOOTSTRAP_ENUMERATION_FAILURE_CODE,
    BOOTSTRAP_ENUMERATION_PROGRESS_EVENT_STEP,
    BootstrapEnumerationExecutor,
    type BootstrapEnumerationQueuePort,
    type BootstrapEnumerationResolverPort,
    type BootstrapEnumerationRunsPort,
    type BootstrapEnumerationStepsPort,
    type BootstrapEnumerationStoragePort,
} from "../src/application/bootstrap-enumeration-executor.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import type { BootstrapMetadataProcessPayload } from "../src/domain/bootstrap-jobs.js";
import type { BootstrapMetadataTaskSeed } from "../src/ports/bootstrap.js";
import type { BootstrapRunDefinition } from "../src/ports/bootstrap-runs.js";

const TEST_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001";
const TEST_ANCHOR = {
    anchorBlock: 100,
    anchorHash:
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    anchorTimestamp: 1726000000,
} as const;

describe("bootstrap enumeration executor", () => {
    it("enumerates tokens, seeds metadata tasks, and queues metadata processing", async () => {
        const harness = createHarness({
            tokenIds: ["1", "2", "3"],
            progress: [
                { resolved: 1, total: 3 },
                { resolved: 3, total: 3 },
            ],
        });

        const result = await harness.executor.execute({
            run: harness.run,
            anchor: TEST_ANCHOR,
            metadataBatchSize: 2,
            traceId: "trace-1",
        });

        expect(result).toEqual(
            expect.objectContaining({
                outcome: BOOTSTRAP_ENUMERATION_EXECUTOR_OUTCOME.MetadataQueued,
                tokenCount: 3,
            }),
        );
        expect(harness.resets).toEqual([
            "snapshot",
            "metadata",
            "image_cache",
            "ownership",
        ]);
        expect(harness.runningSteps).toEqual([
            { runId: 41, stepKey: BOOTSTRAP_STEP_KEY.Enumeration },
            { runId: 41, stepKey: BOOTSTRAP_STEP_KEY.Metadata },
        ]);
        expect(harness.insertedMetadataBatches.map((batch) => batch.length)).toEqual([
            2,
            1,
        ]);
        expect(harness.insertedMetadataBatches[0]?.[0]).toEqual(
            expect.objectContaining({
                runId: 41,
                chainId: 1,
                collectionId: 7,
                contract: TEST_CONTRACT_ADDRESS,
                standard: COLLECTION_STANDARD.Erc721,
                anchorBlock: TEST_ANCHOR.anchorBlock,
                anchorHash: TEST_ANCHOR.anchorHash,
                anchorTimestamp: TEST_ANCHOR.anchorTimestamp,
                tokenId: "1",
            }),
        );
        expect(harness.metadataSchedules).toEqual([
            {
                payload: {
                    chainId: 1,
                    runId: 41,
                    collectionId: 7,
                    address: TEST_CONTRACT_ADDRESS,
                    standard: COLLECTION_STANDARD.Erc721,
                    metadataSnapshotMode: BOOTSTRAP_METADATA_MODE.BestEffort,
                    anchorBlock: TEST_ANCHOR.anchorBlock,
                    anchorHash: TEST_ANCHOR.anchorHash,
                    anchorTimestamp: TEST_ANCHOR.anchorTimestamp,
                },
                traceId: "trace-1",
                delayMs: 0,
            },
        ]);
        expect(harness.events.map((event) => event.eventCode)).toEqual([
            BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationStarted,
            BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationCompleted,
            BOOTSTRAP_RUN_EVENT_CODE.MetadataTasksSeeded,
            BOOTSTRAP_RUN_EVENT_CODE.MetadataQueued,
        ]);
    });

    it("persists bounded intermediate enumeration progress events", async () => {
        const harness = createHarness({
            tokenIds: ["1"],
            progress: [
                {
                    resolved: BOOTSTRAP_ENUMERATION_PROGRESS_EVENT_STEP,
                    total: BOOTSTRAP_ENUMERATION_PROGRESS_EVENT_STEP + 1,
                },
            ],
        });

        await harness.executor.execute({
            run: harness.run,
            anchor: TEST_ANCHOR,
            metadataBatchSize: 1,
            traceId: "trace-1",
        });

        expect(harness.events.map((event) => event.eventCode)).toContain(
            BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationProgress,
        );
    });

    it("fails the enumeration step when token resolution fails", async () => {
        const harness = createHarness({
            resolverError: new Error("enumeration failed"),
        });

        await expect(
            harness.executor.execute({
                run: harness.run,
                anchor: TEST_ANCHOR,
                metadataBatchSize: 2,
                traceId: "trace-1",
            }),
        ).rejects.toThrow("enumeration failed");

        expect(harness.failedSteps).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.Enumeration,
                attempts: 1,
                error: "Error: enumeration failed",
            },
        ]);
        expect(harness.runStatusUpdates).toEqual([
            {
                runId: 41,
                status: BOOTSTRAP_RUN_STATUS.Failed,
                error: {
                    code: BOOTSTRAP_ENUMERATION_FAILURE_CODE.BootstrapStartFailed,
                    message: "Error: enumeration failed",
                },
            },
        ]);
        expect(harness.events.at(-1)).toEqual(
            expect.objectContaining({
                eventCode: BOOTSTRAP_RUN_EVENT_CODE.RunFailed,
            }),
        );
    });

    it("fails the metadata step when task seeding fails", async () => {
        const harness = createHarness({
            tokenIds: ["1"],
            insertError: new Error("seed failed"),
        });

        await expect(
            harness.executor.execute({
                run: harness.run,
                anchor: TEST_ANCHOR,
                metadataBatchSize: 2,
                traceId: "trace-1",
            }),
        ).rejects.toThrow("seed failed");

        expect(harness.failedSteps).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.Metadata,
                attempts: 1,
                error: "Error: seed failed",
            },
        ]);
        expect(harness.metadataSchedules).toEqual([]);
    });
});

type Harness = {
    executor: BootstrapEnumerationExecutor;
    run: BootstrapRunDefinition;
    resets: string[];
    insertedMetadataBatches: BootstrapMetadataTaskSeed[][];
    events: Array<Parameters<BootstrapEnumerationRunsPort["appendRunEvent"]>[0]>;
    runStatusUpdates: Array<{
        runId: number;
        status: BootstrapRunStatus;
        error?: { code: string; message: string } | null;
    }>;
    runningSteps: Array<{ runId: number; stepKey: BootstrapStepKey }>;
    succeededSteps: Array<{
        runId: number;
        stepKey: BootstrapStepKey;
        progress: { completed: number; total: number | null };
    }>;
    failedSteps: Array<{
        runId: number;
        stepKey: BootstrapStepKey;
        attempts: number;
        error: string;
    }>;
    progressUpdates: Array<{
        runId: number;
        stepKey: BootstrapStepKey;
        progress: { completed: number; total: number | null };
    }>;
    metadataSchedules: Array<{
        payload: BootstrapMetadataProcessPayload;
        traceId: string;
        delayMs: number;
    }>;
};

function createHarness(input: {
    tokenIds?: string[];
    progress?: Array<{ resolved: number; total: number | null }>;
    resolverError?: Error;
    insertError?: Error;
}): Harness {
    const run = buildRun();
    const resets: string[] = [];
    const insertedMetadataBatches: BootstrapMetadataTaskSeed[][] = [];
    const events: Harness["events"] = [];
    const runStatusUpdates: Harness["runStatusUpdates"] = [];
    const runningSteps: Harness["runningSteps"] = [];
    const succeededSteps: Harness["succeededSteps"] = [];
    const failedSteps: Harness["failedSteps"] = [];
    const progressUpdates: Harness["progressUpdates"] = [];
    const metadataSchedules: Harness["metadataSchedules"] = [];
    const resolverPort: BootstrapEnumerationResolverPort = {
        resolveTokenIds: async ({ onProgress }) => {
            if (input.resolverError) {
                throw input.resolverError;
            }
            for (const progress of input.progress ?? []) {
                onProgress(progress);
            }
            return input.tokenIds ?? ["1"];
        },
    };
    const storagePort: BootstrapEnumerationStoragePort = {
        resetSnapshot: () => resets.push("snapshot"),
        resetMetadataTasks: () => resets.push("metadata"),
        resetImageCacheTasks: () => resets.push("image_cache"),
        resetOwnershipTasks: () => resets.push("ownership"),
        insertMetadataTasks: (rows) => {
            if (input.insertError) {
                throw input.insertError;
            }
            insertedMetadataBatches.push(rows);
        },
    };
    const runsPort: BootstrapEnumerationRunsPort = {
        updateRunStatus: (runId, status, error) => {
            runStatusUpdates.push({ runId, status, error });
            if (runId === run.runId) {
                run.status = status;
            }
        },
        appendRunEvent: (event) => {
            events.push(event);
        },
    };
    const stepsPort: BootstrapEnumerationStepsPort = {
        markStepRunning: (runId, stepKey) => {
            runningSteps.push({ runId, stepKey });
        },
        markStepSucceeded: (runId, stepKey, progress) => {
            succeededSteps.push({ runId, stepKey, progress });
        },
        markStepFailedTerminal: (failure) => {
            failedSteps.push(failure);
        },
        updateStepProgress: (runId, stepKey, progress) => {
            progressUpdates.push({ runId, stepKey, progress });
        },
    };
    const queuePort: BootstrapEnumerationQueuePort = {
        scheduleMetadataProcess: async (payload, traceId, delayMs) => {
            metadataSchedules.push({ payload, traceId, delayMs });
        },
    };
    const executor = new BootstrapEnumerationExecutor(
        resolverPort,
        storagePort,
        runsPort,
        stepsPort,
        queuePort,
        1,
    );

    return {
        executor,
        run,
        resets,
        insertedMetadataBatches,
        events,
        runStatusUpdates,
        runningSteps,
        succeededSteps,
        failedSteps,
        progressUpdates,
        metadataSchedules,
    };
}

function buildRun(): BootstrapRunDefinition {
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
        status: BOOTSTRAP_RUN_STATUS.Metadata,
        anchorBlock: TEST_ANCHOR.anchorBlock,
        anchorBlockHash: TEST_ANCHOR.anchorHash,
        anchorBlockTimestamp: TEST_ANCHOR.anchorTimestamp,
    };
}
