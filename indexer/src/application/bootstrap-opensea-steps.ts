import {
    BOOTSTRAP_STEP_KEY,
    isBootstrapStepTerminalStatus,
    type BootstrapStepStatus,
} from "@artgod/shared/bootstrap/pipeline";
import type { OpenSeaBootstrapCollectionPayload } from "../domain/opensea-jobs.js";

export type OpenSeaBootstrapStepKey =
    | typeof BOOTSTRAP_STEP_KEY.OpenSeaIdentity
    | typeof BOOTSTRAP_STEP_KEY.OpenSeaSnapshot
    | typeof BOOTSTRAP_STEP_KEY.OpenSeaReady;

// OpenSea bootstrap phases are executed by one worker but journaled as three steps.
export const OPENSEA_BOOTSTRAP_STEP_SEQUENCE: readonly OpenSeaBootstrapStepKey[] =
    [
        BOOTSTRAP_STEP_KEY.OpenSeaIdentity,
        BOOTSTRAP_STEP_KEY.OpenSeaSnapshot,
        BOOTSTRAP_STEP_KEY.OpenSeaReady,
    ];

export interface BootstrapOpenSeaStepsPort {
    getStep(
        runId: number,
        stepKey: OpenSeaBootstrapStepKey,
    ): { status: BootstrapStepStatus } | null;
    markStepRunning(runId: number, stepKey: OpenSeaBootstrapStepKey): void;
    markStepSucceeded(runId: number, stepKey: OpenSeaBootstrapStepKey): void;
    markStepFailedRetry(input: {
        runId: number;
        stepKey: OpenSeaBootstrapStepKey;
        attempts: number;
        nextAttemptAt: number;
        error: string;
    }): void;
    markStepFailedTerminal(input: {
        runId: number;
        stepKey: OpenSeaBootstrapStepKey;
        attempts: number;
        error: string;
    }): void;
}

// Returns true when all OpenSea phase rows have already reached terminal state.
export function areOpenSeaBootstrapStepsTerminal(
    stepsPort: BootstrapOpenSeaStepsPort,
    payload: OpenSeaBootstrapCollectionPayload,
): boolean {
    const bootstrapRunId = payload.bootstrap?.runId;
    if (!bootstrapRunId) {
        return false;
    }
    return OPENSEA_BOOTSTRAP_STEP_SEQUENCE.every((stepKey) => {
        const step = stepsPort.getStep(bootstrapRunId, stepKey);
        return step ? isBootstrapStepTerminalStatus(step.status) : false;
    });
}

// Marks one OpenSea phase as running when the job belongs to a bootstrap run.
export function markOpenSeaBootstrapStepRunning(
    stepsPort: BootstrapOpenSeaStepsPort,
    payload: OpenSeaBootstrapCollectionPayload,
    stepKey: OpenSeaBootstrapStepKey,
): void {
    const bootstrapRunId = payload.bootstrap?.runId;
    if (!bootstrapRunId) {
        return;
    }
    stepsPort.markStepRunning(bootstrapRunId, stepKey);
}

// Marks one OpenSea phase as succeeded when the job belongs to a bootstrap run.
export function markOpenSeaBootstrapStepSucceeded(
    stepsPort: BootstrapOpenSeaStepsPort,
    payload: OpenSeaBootstrapCollectionPayload,
    stepKey: OpenSeaBootstrapStepKey,
): void {
    const bootstrapRunId = payload.bootstrap?.runId;
    if (!bootstrapRunId) {
        return;
    }
    stepsPort.markStepSucceeded(bootstrapRunId, stepKey);
}

// Records a retryable OpenSea phase failure on the active bootstrap step.
export function markOpenSeaBootstrapStepRetry(input: {
    stepsPort: BootstrapOpenSeaStepsPort;
    payload: OpenSeaBootstrapCollectionPayload;
    stepKey: OpenSeaBootstrapStepKey;
    attempts: number;
    nextAttemptAt: number;
    error: string;
}): void {
    const bootstrapRunId = input.payload.bootstrap?.runId;
    if (!bootstrapRunId) {
        return;
    }
    input.stepsPort.markStepFailedRetry({
        runId: bootstrapRunId,
        stepKey: input.stepKey,
        attempts: input.attempts,
        nextAttemptAt: input.nextAttemptAt,
        error: input.error,
    });
}

// Terminal OpenSea failure closes the active phase and every downstream phase.
export function markOpenSeaBootstrapTerminalFailure(input: {
    stepsPort: BootstrapOpenSeaStepsPort;
    payload: OpenSeaBootstrapCollectionPayload;
    activeStep: OpenSeaBootstrapStepKey;
    attempts: number;
    error: string;
}): void {
    const bootstrapRunId = input.payload.bootstrap?.runId;
    if (!bootstrapRunId) {
        return;
    }
    const activeIndex = OPENSEA_BOOTSTRAP_STEP_SEQUENCE.indexOf(
        input.activeStep,
    );
    for (const stepKey of OPENSEA_BOOTSTRAP_STEP_SEQUENCE.slice(activeIndex)) {
        input.stepsPort.markStepFailedTerminal({
            runId: bootstrapRunId,
            stepKey,
            attempts: input.attempts,
            error: input.error,
        });
    }
}
