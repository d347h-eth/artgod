import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import {
    BOOTSTRAP_STEP_KEY,
    isBootstrapStepTerminalStatus,
    type BootstrapStepStatus,
    type BootstrapTaskCounts,
} from "@artgod/shared/bootstrap/pipeline";

// Extension artifact skip reasons are persisted on bootstrap_run_steps.result_json.
export const BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_STEP_RESULT_REASON = {
    NoMetadataTasks: "no metadata tasks available",
} as const;

// Extension artifact failure messages are surfaced in run detail side-lane chips.
export const BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE = {
    InstallMissing: "Collection extension install missing",
    ImplementationMissing: "Collection extension implementation missing",
    TerminalTaskFailures:
        "Bootstrap collection-extension artifacts completed with terminal failures",
} as const;

export type BootstrapCollectionExtensionArtifactRunRef = {
    runId: number;
    chainId: number;
    collectionId: number;
};

export interface BootstrapCollectionExtensionArtifactRunsPort {
    appendRunEvent(input: {
        runId: number;
        chainId: number;
        collectionId: number;
        eventCode: string;
        eventLevel: "info" | "warn" | "error";
        message: string;
        payloadJson: string | null;
    }): void;
}

export interface BootstrapCollectionExtensionArtifactStepsPort {
    getStep(
        runId: number,
        stepKey: typeof BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
    ): { status: BootstrapStepStatus } | null;
    markStepSucceeded(
        runId: number,
        stepKey: typeof BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
        progress?: { completed: number; total: number | null },
    ): void;
    markStepSkipped(
        runId: number,
        stepKey: typeof BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
        reason: string,
    ): void;
    markStepFailedTerminal(input: {
        runId: number;
        stepKey: typeof BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts;
        attempts: number;
        error: string;
    }): void;
    updateStepProgress(
        runId: number,
        stepKey: typeof BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
        progress: { completed: number; total: number | null },
    ): void;
}

// Persists collection-extension artifact progress on the side-lane step row.
export function updateCollectionExtensionArtifactStepProgress(input: {
    stepsPort: BootstrapCollectionExtensionArtifactStepsPort;
    runId: number;
    counts: BootstrapTaskCounts;
}): void {
    input.stepsPort.updateStepProgress(
        input.runId,
        BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
        {
            completed: input.counts.succeeded + input.counts.failedTerminal,
            total: input.counts.total,
        },
    );
}

// Marks the extension-artifact step terminal once no task can make more progress.
export function completeCollectionExtensionArtifactStepIfTerminal(input: {
    runsPort: BootstrapCollectionExtensionArtifactRunsPort;
    stepsPort: BootstrapCollectionExtensionArtifactStepsPort;
    run: BootstrapCollectionExtensionArtifactRunRef;
    counts: BootstrapTaskCounts;
}): boolean {
    if (
        isCollectionExtensionArtifactStepTerminal(
            input.stepsPort,
            input.run.runId,
        )
    ) {
        return true;
    }
    updateCollectionExtensionArtifactStepProgress({
        stepsPort: input.stepsPort,
        runId: input.run.runId,
        counts: input.counts,
    });
    if (input.counts.pending > 0 || input.counts.retry > 0) {
        return false;
    }
    if (input.counts.total <= 0) {
        input.stepsPort.markStepSkipped(
            input.run.runId,
            BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
            BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_STEP_RESULT_REASON.NoMetadataTasks,
        );
        input.runsPort.appendRunEvent({
            ...input.run,
            eventCode:
                BOOTSTRAP_RUN_EVENT_CODE.CollectionExtensionArtifactsSkipped,
            eventLevel: "info",
            message:
                "Bootstrap collection-extension artifacts skipped because no metadata tasks were available",
            payloadJson: null,
        });
        return true;
    }
    if (input.counts.failedTerminal > 0) {
        input.stepsPort.markStepFailedTerminal({
            runId: input.run.runId,
            stepKey: BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
            attempts: input.counts.failedTerminal,
            error: BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE.TerminalTaskFailures,
        });
        input.runsPort.appendRunEvent({
            ...input.run,
            eventCode: BOOTSTRAP_RUN_EVENT_CODE.CollectionExtensionArtifactsFailed,
            eventLevel: "warn",
            message:
                BOOTSTRAP_COLLECTION_EXTENSION_ARTIFACT_FAILURE_MESSAGE.TerminalTaskFailures,
            payloadJson: JSON.stringify(input.counts),
        });
        return true;
    }

    input.stepsPort.markStepSucceeded(
        input.run.runId,
        BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
        {
            completed: input.counts.total,
            total: input.counts.total,
        },
    );
    input.runsPort.appendRunEvent({
        ...input.run,
        eventCode: BOOTSTRAP_RUN_EVENT_CODE.CollectionExtensionArtifactsCompleted,
        eventLevel: "info",
        message: "Bootstrap collection-extension artifacts completed",
        payloadJson: JSON.stringify(input.counts),
    });
    return true;
}

// Marks the whole extension-artifact step failed when no per-token task can run.
export function failCollectionExtensionArtifactStep(input: {
    runsPort: BootstrapCollectionExtensionArtifactRunsPort;
    stepsPort: BootstrapCollectionExtensionArtifactStepsPort;
    run: BootstrapCollectionExtensionArtifactRunRef;
    error: string;
}): void {
    if (
        isCollectionExtensionArtifactStepTerminal(
            input.stepsPort,
            input.run.runId,
        )
    ) {
        return;
    }
    input.stepsPort.markStepFailedTerminal({
        runId: input.run.runId,
        stepKey: BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
        attempts: 1,
        error: input.error,
    });
    input.runsPort.appendRunEvent({
        ...input.run,
        eventCode: BOOTSTRAP_RUN_EVENT_CODE.CollectionExtensionArtifactsFailed,
        eventLevel: "error",
        message: input.error,
        payloadJson: null,
    });
}

function isCollectionExtensionArtifactStepTerminal(
    stepsPort: BootstrapCollectionExtensionArtifactStepsPort,
    runId: number,
): boolean {
    const step = stepsPort.getStep(
        runId,
        BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
    );
    return step ? isBootstrapStepTerminalStatus(step.status) : false;
}
