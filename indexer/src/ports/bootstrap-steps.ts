import type {
    BootstrapStepKey,
    BootstrapStepStatus,
} from "@artgod/shared/bootstrap/pipeline";

// Durable bootstrap step row exposed to the runtime orchestrator.
export type BootstrapStepRecord = {
    runId: number;
    stepKey: BootstrapStepKey;
    status: BootstrapStepStatus;
    blocking: boolean;
    progressCompleted: number;
    progressTotal: number | null;
    attempts: number;
    lastError: string | null;
};

// Progress summary persisted on bootstrap_run_steps for run detail polling.
export type BootstrapStepProgress = {
    completed: number;
    total: number | null;
};

// Port for mutating durable bootstrap step state without coupling executors to SQLite.
export interface BootstrapStepsPort {
    getStep(runId: number, stepKey: BootstrapStepKey): BootstrapStepRecord | null;
    markStepRunning(runId: number, stepKey: BootstrapStepKey): void;
    markStepSucceeded(
        runId: number,
        stepKey: BootstrapStepKey,
        progress?: BootstrapStepProgress,
    ): void;
    markStepSkipped(
        runId: number,
        stepKey: BootstrapStepKey,
        reason: string,
    ): void;
    markStepFailedRetry(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        attempts: number;
        nextAttemptAt: number;
        error: string;
    }): void;
    markStepFailedTerminal(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        attempts: number;
        error: string;
    }): void;
    updateStepProgress(
        runId: number,
        stepKey: BootstrapStepKey,
        progress: BootstrapStepProgress,
    ): void;
    isStepPaused(runId: number, stepKey: BootstrapStepKey): boolean;
}
