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
    dependsOn: BootstrapStepKey[];
    nextAttemptAt: number;
    leaseOwner: string | null;
    leaseUntil: number | null;
    progressCompleted: number;
    progressTotal: number | null;
    resultJson: string | null;
    attempts: number;
    lastError: string | null;
};

// Progress summary persisted on bootstrap_run_steps for run detail polling.
export type BootstrapStepProgress = {
    completed: number;
    total: number | null;
};

// Query shape for finding due bootstrap work scoped to one scheduler lane.
export type BootstrapDueStepRunQuery = {
    chainId: number;
    stepKeys: readonly BootstrapStepKey[];
    nowMs: number;
    limit: number;
};

// Query shape for calculating the next scheduler wake deadline for a lane.
export type BootstrapNextDueStepQuery = {
    chainId: number;
    stepKeys: readonly BootstrapStepKey[];
};

// Port for mutating durable bootstrap step state without coupling executors to SQLite.
export interface BootstrapStepsPort {
    getStep(runId: number, stepKey: BootstrapStepKey): BootstrapStepRecord | null;
    listRunSteps(runId: number): BootstrapStepRecord[];
    listDueStepRunIds(input: BootstrapDueStepRunQuery): number[];
    getNextDueStepAt(input: BootstrapNextDueStepQuery): number | null;
    claimReadySteps(input: {
        runId: number;
        stepKeys: readonly BootstrapStepKey[];
        leaseOwner: string;
        leaseUntil: number;
        nowMs: number;
        limit: number;
    }): BootstrapStepRecord[];
    releaseStepLease(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        leaseOwner: string;
        nextAttemptAt: number;
    }): void;
    releaseStepLeaseAsRunning(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        leaseOwner: string;
        nextAttemptAt: number;
    }): void;
    renewStepLease(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        leaseOwner: string;
        leaseUntil: number;
    }): void;
    markStepReady(runId: number, stepKey: BootstrapStepKey): void;
    markStepRunning(runId: number, stepKey: BootstrapStepKey): void;
    markStepDelegatedRunning(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        healthCheckAt: number;
    }): void;
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
    updateStepResult(
        runId: number,
        stepKey: BootstrapStepKey,
        result: Record<string, unknown>,
    ): void;
    isStepPaused(runId: number, stepKey: BootstrapStepKey): boolean;
}
