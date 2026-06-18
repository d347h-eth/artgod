import {
    BOOTSTRAP_STEP_KEY,
    type BootstrapStepKey,
    type BootstrapTaskCounts,
} from "@artgod/shared/bootstrap/pipeline";
import type { BootstrapSnapshotPort } from "../ports/bootstrap.js";
import type { BootstrapStepsPort } from "../ports/bootstrap-steps.js";
import type {
    BootstrapStepProgressObservation,
    BootstrapStepProgressObserverPort,
} from "./bootstrap-step-orchestrator.js";

// Reads existing durable bootstrap progress so leases renew only while a step is alive.
export class BootstrapStepProgressObserver
    implements BootstrapStepProgressObserverPort
{
    constructor(
        private readonly stepsPort: Pick<BootstrapStepsPort, "getStep">,
        private readonly storagePort: Pick<
            BootstrapSnapshotPort,
            | "getMetadataTaskCounts"
            | "getImageCacheTaskCounts"
            | "getOwnershipTaskCounts"
            | "getCollectionExtensionArtifactTaskCounts"
        >,
    ) {}

    observeStepProgress(input: {
        runId: number;
        stepKey: BootstrapStepKey;
    }): BootstrapStepProgressObservation | null {
        const step = this.stepsPort.getStep(input.runId, input.stepKey);
        if (!step) {
            return null;
        }

        const taskCounts = this.getTaskCounts(input.runId, input.stepKey);
        if (taskCounts) {
            return {
                completed: taskCounts.succeeded + taskCounts.failedTerminal,
                total: taskCounts.total,
                fingerprint: stringifyProgressFingerprint([
                    step.status,
                    taskCounts.pending,
                    taskCounts.retry,
                    taskCounts.succeeded,
                    taskCounts.failedTerminal,
                    taskCounts.total,
                ]),
            };
        }

        return {
            completed: step.progressCompleted,
            total: step.progressTotal,
            fingerprint: stringifyProgressFingerprint([
                step.status,
                step.progressCompleted,
                step.progressTotal,
                step.resultJson,
            ]),
        };
    }

    private getTaskCounts(
        runId: number,
        stepKey: BootstrapStepKey,
    ): BootstrapTaskCounts | null {
        if (stepKey === BOOTSTRAP_STEP_KEY.Metadata) {
            return this.storagePort.getMetadataTaskCounts(runId);
        }
        if (stepKey === BOOTSTRAP_STEP_KEY.ImageCache) {
            return this.storagePort.getImageCacheTaskCounts(runId);
        }
        if (stepKey === BOOTSTRAP_STEP_KEY.Ownership) {
            return this.storagePort.getOwnershipTaskCounts(runId);
        }
        if (stepKey === BOOTSTRAP_STEP_KEY.CollectionExtensionArtifacts) {
            return this.storagePort.getCollectionExtensionArtifactTaskCounts(
                runId,
            );
        }
        return null;
    }
}

function stringifyProgressFingerprint(values: readonly unknown[]): string {
    return JSON.stringify(values);
}
