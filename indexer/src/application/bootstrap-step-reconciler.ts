import {
    BOOTSTRAP_STEP_STATUS,
    areBootstrapStepDependenciesSatisfied,
    isBootstrapStepWakeableStatus,
    type BootstrapStepDependencyRecord,
    type BootstrapStepKey,
    type BootstrapStepStatus,
} from "@artgod/shared/bootstrap/pipeline";

export type BootstrapReconcilerStep = BootstrapStepDependencyRecord & {
    dependsOn: readonly BootstrapStepKey[];
};

// Finds pending steps that can become ready from the persisted dependency graph.
export function resolveReadyBootstrapSteps(
    steps: readonly BootstrapReconcilerStep[],
): BootstrapStepKey[] {
    const dependencyRecords = steps.map((step) => ({
        stepKey: step.stepKey,
        status: step.status,
    }));
    return steps
        .filter(
            (step) =>
                step.status === BOOTSTRAP_STEP_STATUS.Pending &&
                areBootstrapStepDependenciesSatisfied(
                    step.dependsOn,
                    dependencyRecords,
                ),
        )
        .map((step) => step.stepKey);
}

// Returns steps that should have executor work republished after restart or resume.
export function resolveWakeableBootstrapSteps(
    steps: readonly BootstrapReconcilerStep[],
    readyStepKeys: readonly BootstrapStepKey[],
): BootstrapStepKey[] {
    const readySet = new Set(readyStepKeys);
    return steps
        .filter((step) => isStepWakeable(step.status, readySet.has(step.stepKey)))
        .map((step) => step.stepKey);
}

function isStepWakeable(
    status: BootstrapStepStatus,
    isNewlyReady: boolean,
): boolean {
    return isNewlyReady || isBootstrapStepWakeableStatus(status);
}
