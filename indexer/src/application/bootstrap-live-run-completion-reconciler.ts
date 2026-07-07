import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    isBootstrapStepDependencySatisfied,
    isBootstrapStepTerminalStatus,
} from "@artgod/shared/bootstrap/pipeline";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import type { BootstrapRunDefinition } from "../ports/bootstrap-runs.js";
import type { BootstrapStepRecord } from "../ports/bootstrap-steps.js";
import type { CollectionRecord } from "../domain/collections.js";
import {
    cleanupSuccessfulBootstrapTemporaryData,
    type BootstrapTemporaryDataCleanupResult,
    type BootstrapTemporaryDataRunsPort,
    type BootstrapTemporaryDataStoragePort,
} from "./bootstrap-temporary-data-cleanup.js";

export type BootstrapLiveRunCompletionReconcileResult = {
    completed: boolean;
    cleanup: BootstrapTemporaryDataCleanupResult;
};

export interface BootstrapLiveRunCompletionCollectionPort {
    getCollection(
        chainId: number,
        collectionId: number,
    ): CollectionRecord | null;
}

export interface BootstrapLiveRunCompletionRunsPort
    extends BootstrapTemporaryDataRunsPort {
    updateRunStatus(
        runId: number,
        status: typeof BOOTSTRAP_RUN_STATUS.Completed,
        error?: null,
    ): void;
}

export interface BootstrapLiveRunCompletionStepsPort {
    listRunSteps(runId: number): BootstrapStepRecord[];
}

export interface BootstrapLiveRunCompletionTemporaryDataPort
    extends BootstrapTemporaryDataStoragePort {}

// Restores completed run status after live collection side-lanes settle.
export class BootstrapLiveRunCompletionReconciler {
    constructor(
        private readonly collectionPort: BootstrapLiveRunCompletionCollectionPort,
        private readonly runsPort: BootstrapLiveRunCompletionRunsPort,
        private readonly stepsPort: BootstrapLiveRunCompletionStepsPort,
        private readonly temporaryDataPort: BootstrapLiveRunCompletionTemporaryDataPort,
    ) {}

    reconcile(
        runId: number,
    ): BootstrapLiveRunCompletionReconcileResult {
        const run = this.runsPort.getRun(runId);
        if (!run || !isRunCompletionRecoverable(run)) {
            return buildIdleResult();
        }

        const collection = this.collectionPort.getCollection(
            run.chainId,
            run.collectionId,
        );
        if (collection?.status !== COLLECTION_STATUS.Live) {
            return buildIdleResult();
        }

        const steps = this.stepsPort.listRunSteps(run.runId);
        if (!isLiveRunCompletionSettled(steps)) {
            return buildIdleResult();
        }

        this.runsPort.updateRunStatus(
            run.runId,
            BOOTSTRAP_RUN_STATUS.Completed,
        );
        const cleanup = cleanupSuccessfulBootstrapTemporaryData({
            bootstrapStorage: this.temporaryDataPort,
            bootstrapRuns: this.runsPort,
            runId: run.runId,
            collectionExtensionArtifactsTerminal:
                isCollectionExtensionArtifactStepTerminal(steps),
        });
        return { completed: true, cleanup };
    }
}

function isRunCompletionRecoverable(run: BootstrapRunDefinition): boolean {
    return (
        run.status !== BOOTSTRAP_RUN_STATUS.Completed &&
        run.status !== BOOTSTRAP_RUN_STATUS.Failed
    );
}

function isLiveRunCompletionSettled(
    steps: readonly BootstrapStepRecord[],
): boolean {
    return (
        hasCollectionLiveStepSatisfied(steps) &&
        steps.every((step) =>
            step.blocking
                ? isBootstrapStepDependencySatisfied(step.status)
                : isBootstrapStepTerminalStatus(step.status),
        )
    );
}

function hasCollectionLiveStepSatisfied(
    steps: readonly BootstrapStepRecord[],
): boolean {
    const step = steps.find(
        (candidate) =>
            candidate.stepKey === BOOTSTRAP_STEP_KEY.CollectionLive,
    );
    return step ? isBootstrapStepDependencySatisfied(step.status) : false;
}

function isCollectionExtensionArtifactStepTerminal(
    steps: readonly BootstrapStepRecord[],
): boolean {
    const step = steps.find(
        (candidate) =>
            candidate.stepKey ===
            BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts,
    );
    return step ? isBootstrapStepTerminalStatus(step.status) : false;
}

function buildIdleResult(): BootstrapLiveRunCompletionReconcileResult {
    return {
        completed: false,
        cleanup: { deleted: false },
    };
}
