import { describe, expect, it } from "vitest";
import {
    BOOTSTRAP_STEP_KEY,
    type BootstrapTaskCounts,
} from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import {
    BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE,
    completeCollectionExtensionArtifactStepIfTerminal,
    failCollectionExtensionArtifactStep,
    type BootstrapCollectionExtensionArtifactRunsPort,
    type BootstrapCollectionExtensionArtifactStepsPort,
} from "../src/application/bootstrap-collection-extension-artifacts.js";

describe("bootstrap collection-extension artifact steps", () => {
    it("marks the step succeeded when every artifact task succeeded", () => {
        const harness = createHarness();

        const terminal = completeCollectionExtensionArtifactStepIfTerminal({
            runsPort: harness.runs,
            stepsPort: harness.steps,
            run: harness.run,
            counts: counts({ succeeded: 4, total: 4 }),
        });

        expect(terminal).toBe(true);
        expect(harness.succeeded).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
                progress: { completed: 4, total: 4 },
            },
        ]);
        expect(harness.events.map((event) => event.eventCode)).toEqual([
            BOOTSTRAP_RUN_EVENT_CODE.CollectionExtensionArtifactsCompleted,
        ]);
    });

    it("keeps the step nonterminal while artifact tasks can still run", () => {
        const harness = createHarness();

        const terminal = completeCollectionExtensionArtifactStepIfTerminal({
            runsPort: harness.runs,
            stepsPort: harness.steps,
            run: harness.run,
            counts: counts({ pending: 1, succeeded: 3, total: 4 }),
        });

        expect(terminal).toBe(false);
        expect(harness.progress).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
                progress: { completed: 3, total: 4 },
            },
        ]);
        expect(harness.succeeded).toEqual([]);
        expect(harness.failedTerminal).toEqual([]);
    });

    it("marks the step failed when setup prevents any task from running", () => {
        const harness = createHarness();

        failCollectionExtensionArtifactStep({
            runsPort: harness.runs,
            stepsPort: harness.steps,
            run: harness.run,
            error: BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE.InstallMissing,
        });

        expect(harness.failedTerminal).toEqual([
            {
                runId: 41,
                stepKey: BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
                attempts: 1,
                error: BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE.InstallMissing,
            },
        ]);
        expect(harness.events.map((event) => event.eventCode)).toEqual([
            BOOTSTRAP_RUN_EVENT_CODE.CollectionExtensionArtifactsFailed,
        ]);
    });
});

function counts(
    overrides: Partial<BootstrapTaskCounts> = {},
): BootstrapTaskCounts {
    return {
        pending: 0,
        retry: 0,
        succeeded: 0,
        failedTerminal: 0,
        total: 0,
        ...overrides,
    };
}

function createHarness() {
    const run = { runId: 41, chainId: 1, collectionId: 7 };
    const events: Array<{ eventCode: string }> = [];
    const progress: Array<{
        runId: number;
        stepKey: typeof BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts;
        progress: { completed: number; total: number | null };
    }> = [];
    const succeeded: typeof progress = [];
    const failedTerminal: Array<{
        runId: number;
        stepKey: typeof BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts;
        attempts: number;
        error: string;
    }> = [];
    const runs: BootstrapCollectionExtensionArtifactRunsPort = {
        appendRunEvent: (event) => {
            events.push({ eventCode: event.eventCode });
        },
    };
    const steps: BootstrapCollectionExtensionArtifactStepsPort = {
        getStep: () => null,
        markStepSucceeded: (runId, stepKey, stepProgress) => {
            succeeded.push({
                runId,
                stepKey,
                progress: stepProgress ?? { completed: 1, total: 1 },
            });
        },
        markStepSkipped: () => {},
        markStepFailedTerminal: (input) => {
            failedTerminal.push(input);
        },
        updateStepProgress: (runId, stepKey, stepProgress) => {
            progress.push({
                runId,
                stepKey,
                progress: stepProgress,
            });
        },
    };
    return {
        run,
        runs,
        steps,
        events,
        progress,
        succeeded,
        failedTerminal,
    };
}
