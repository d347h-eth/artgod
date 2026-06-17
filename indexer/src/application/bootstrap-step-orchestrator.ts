import {
    isBootstrapStepTerminalStatus,
    type BootstrapStepKey,
} from "@artgod/shared/bootstrap/pipeline";
import { logger } from "@artgod/shared/utils";
import { getRetryDelayMs, type RetryPolicy } from "../domain/retry.js";
import type { BootstrapRunDefinition } from "../ports/bootstrap-runs.js";
import type { BootstrapStepRecord } from "../ports/bootstrap-steps.js";
import { resolveReadyBootstrapSteps } from "./bootstrap-step-reconciler.js";

// Structured scheduler component label used by bootstrap orchestration logs.
export const BOOTSTRAP_STEP_ORCHESTRATOR_COMPONENT =
    "BootstrapStepOrchestrator";

// Scheduler log actions describe durable step state transitions.
export const BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION = {
    StepReady: "step_ready",
    OutOfLaneWake: "out_of_lane_wake",
    StepClaimed: "step_claimed",
    LeaseRenewalProgressStale: "lease_renewal_progress_stale",
    LeaseRenewalObserveFailed: "lease_renewal_observe_failed",
    StepReleasedReady: "step_released_ready",
    StepDelegated: "step_delegated",
    StepTerminalObserved: "step_terminal_observed",
    StepRetryScheduled: "step_retry_scheduled",
    StepTerminalFailed: "step_terminal_failed",
    InvalidOutcome: "invalid_outcome",
} as const;

const BOOTSTRAP_STEP_ORCHESTRATOR_LOG_MESSAGE =
    "Bootstrap step scheduler transition";

// Step processor release modes tell the orchestrator how to persist lease state.
export const BOOTSTRAP_STEP_PROCESSOR_RELEASE = {
    Ready: "ready",
    Running: "running",
    Terminal: "terminal",
} as const;

export type BootstrapStepProcessorRelease =
    (typeof BOOTSTRAP_STEP_PROCESSOR_RELEASE)[keyof typeof BOOTSTRAP_STEP_PROCESSOR_RELEASE];

// Result returned by a bounded claimed step processor.
export type BootstrapClaimedStepProcessorResult =
    | {
          release: typeof BOOTSTRAP_STEP_PROCESSOR_RELEASE.Ready;
          nextAttemptAt: number;
      }
    | {
          release: typeof BOOTSTRAP_STEP_PROCESSOR_RELEASE.Running;
          nextAttemptAt: number;
      }
    | {
          release: typeof BOOTSTRAP_STEP_PROCESSOR_RELEASE.Terminal;
      };

// Orchestration errors are persisted as step errors when a processor violates its contract.
export const BOOTSTRAP_STEP_ORCHESTRATION_ERROR = {
    ProcessorException: "processor_exception",
    InvalidReadyOutcome: "invalid_ready_outcome",
    InvalidTerminalOutcome: "invalid_terminal_outcome",
    InvalidRunningOutcome: "invalid_running_outcome",
} as const;

export type BootstrapStepOrchestratorInput = {
    runId: number;
    traceId: string;
    laneName: string;
    laneStepKeys: readonly BootstrapStepKey[];
    leaseOwner: string;
    leaseMs: number;
    maxProgressStaleMs: number;
    claimLimit: number;
    maxIterations: number;
    retryPolicy: RetryPolicy;
};

export type BootstrapStepOrchestratorResult = {
    runId: number;
    claimedStepKeys: BootstrapStepKey[];
    readyStepKeys: BootstrapStepKey[];
    wakeStepKeys: BootstrapStepKey[];
};

export interface BootstrapStepOrchestratorRunsPort {
    getRun(runId: number): BootstrapRunDefinition | null;
}

export interface BootstrapStepOrchestratorStepsPort {
    listRunSteps(runId: number): BootstrapStepRecord[];
    markStepReady(runId: number, stepKey: BootstrapStepKey): void;
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
}

export interface BootstrapClaimedStepProcessorPort {
    processClaimedStep(input: {
        run: BootstrapRunDefinition;
        step: BootstrapStepRecord;
        leaseOwner: string;
        traceId: string;
    }): Promise<BootstrapClaimedStepProcessorResult>;
}

export interface BootstrapStepWakePort {
    wakeBootstrapStep(input: {
        run: BootstrapRunDefinition;
        stepKey: BootstrapStepKey;
        traceId: string;
    }): Promise<void>;
}

export type BootstrapStepProgressObservation = {
    fingerprint: string;
    completed: number;
    total: number | null;
};

export interface BootstrapStepProgressObserverPort {
    observeStepProgress(input: {
        runId: number;
        stepKey: BootstrapStepKey;
    }): BootstrapStepProgressObservation | null;
}

export interface BootstrapStepOrchestratorLoggerPort {
    debug(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
}

const NOOP_BOOTSTRAP_STEP_PROGRESS_OBSERVER: BootstrapStepProgressObserverPort = {
    observeStepProgress: () => null,
};

// Reconciles dependencies, claims due steps with leases, and executes bounded processors.
export class BootstrapStepOrchestrator {
    constructor(
        private readonly runsPort: BootstrapStepOrchestratorRunsPort,
        private readonly stepsPort: BootstrapStepOrchestratorStepsPort,
        private readonly processorPort: BootstrapClaimedStepProcessorPort,
        private readonly wakePort: BootstrapStepWakePort,
        private readonly nowMs: () => number = Date.now,
        private readonly loggerPort: BootstrapStepOrchestratorLoggerPort = logger,
        private readonly progressObserverPort: BootstrapStepProgressObserverPort = NOOP_BOOTSTRAP_STEP_PROGRESS_OBSERVER,
    ) {}

    async run(
        input: BootstrapStepOrchestratorInput,
    ): Promise<BootstrapStepOrchestratorResult> {
        const claimedStepKeys: BootstrapStepKey[] = [];
        const readyStepKeys: BootstrapStepKey[] = [];
        const wakeStepKeys: BootstrapStepKey[] = [];
        for (
            let iteration = 0;
            iteration < Math.max(1, input.maxIterations);
            iteration += 1
        ) {
            const run = this.runsPort.getRun(input.runId);
            if (!run) {
                break;
            }

            const readyNow = await this.reconcile(run, input, wakeStepKeys);
            readyStepKeys.push(...readyNow);

            const nowMs = this.nowMs();
            const leaseUntil = nowMs + Math.max(1, input.leaseMs);
            const claimedSteps = this.stepsPort.claimReadySteps({
                runId: input.runId,
                stepKeys: input.laneStepKeys,
                leaseOwner: input.leaseOwner,
                leaseUntil,
                nowMs,
                limit: Math.max(1, input.claimLimit),
            });
            if (claimedSteps.length === 0) {
                break;
            }

            for (const step of claimedSteps) {
                claimedStepKeys.push(step.stepKey);
                this.logDebug(
                    input,
                    run,
                    step.stepKey,
                    BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION.StepClaimed,
                    {
                        attempts: step.attempts,
                        leaseUntil,
                        nextAttemptAt: step.nextAttemptAt,
                    },
                );
                await this.processClaimedStep(run, step, input);
            }
        }

        return {
            runId: input.runId,
            claimedStepKeys,
            readyStepKeys,
            wakeStepKeys,
        };
    }

    private async reconcile(
        run: BootstrapRunDefinition,
        input: BootstrapStepOrchestratorInput,
        wakeStepKeys: BootstrapStepKey[],
    ): Promise<BootstrapStepKey[]> {
        const steps = this.stepsPort.listRunSteps(run.runId);
        const readyStepKeys = resolveReadyBootstrapSteps(steps);
        for (const stepKey of readyStepKeys) {
            this.stepsPort.markStepReady(run.runId, stepKey);
            this.logDebug(
                input,
                run,
                stepKey,
                BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION.StepReady,
            );
            if (!input.laneStepKeys.includes(stepKey)) {
                wakeStepKeys.push(stepKey);
                await this.wakePort.wakeBootstrapStep({
                    run,
                    stepKey,
                    traceId: input.traceId,
                });
                this.logDebug(
                    input,
                    run,
                    stepKey,
                    BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION.OutOfLaneWake,
                );
            }
        }
        return readyStepKeys;
    }

    private async processClaimedStep(
        run: BootstrapRunDefinition,
        step: BootstrapStepRecord,
        input: BootstrapStepOrchestratorInput,
    ): Promise<void> {
        let result: BootstrapClaimedStepProcessorResult;
        const stopLeaseRenewal = this.startLeaseRenewal(run, step, input);
        try {
            result = await this.processorPort.processClaimedStep({
                run,
                step,
                leaseOwner: input.leaseOwner,
                traceId: input.traceId,
            });
        } catch (error) {
            this.markProcessorException(run, step, input, error);
            return;
        } finally {
            stopLeaseRenewal();
        }
        const currentStep = this.stepsPort
            .listRunSteps(run.runId)
            .find((candidate) => candidate.stepKey === step.stepKey);
        if (
            currentStep &&
            isBootstrapStepTerminalStatus(currentStep.status)
        ) {
            this.logDebug(
                input,
                run,
                step.stepKey,
                BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION.StepTerminalObserved,
                {
                    status: currentStep.status,
                    attempts: currentStep.attempts,
                },
            );
            return;
        }
        if (result.release === BOOTSTRAP_STEP_PROCESSOR_RELEASE.Terminal) {
            this.markInvalidOutcome(
                run,
                step,
                input,
                BOOTSTRAP_STEP_ORCHESTRATION_ERROR.InvalidTerminalOutcome,
                "Processor returned terminal without terminal step state",
            );
            return;
        }
        if (result.release === BOOTSTRAP_STEP_PROCESSOR_RELEASE.Running) {
            if (!Number.isFinite(result.nextAttemptAt)) {
                this.markInvalidOutcome(
                    run,
                    step,
                    input,
                    BOOTSTRAP_STEP_ORCHESTRATION_ERROR.InvalidRunningOutcome,
                    "Processor delegated running work without a deadline",
                );
                return;
            }
            this.stepsPort.releaseStepLeaseAsRunning({
                runId: run.runId,
                stepKey: step.stepKey,
                leaseOwner: input.leaseOwner,
                nextAttemptAt: result.nextAttemptAt,
            });
            this.logDebug(
                input,
                run,
                step.stepKey,
                BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION.StepDelegated,
                {
                    healthCheckAt: result.nextAttemptAt,
                },
            );
            return;
        }
        if (!Number.isFinite(result.nextAttemptAt)) {
            this.markInvalidOutcome(
                run,
                step,
                input,
                BOOTSTRAP_STEP_ORCHESTRATION_ERROR.InvalidReadyOutcome,
                "Processor released incomplete work without a deadline",
            );
            return;
        }
        this.stepsPort.releaseStepLease({
            runId: run.runId,
            stepKey: step.stepKey,
            leaseOwner: input.leaseOwner,
            nextAttemptAt: result.nextAttemptAt,
        });
        this.logDebug(
            input,
            run,
            step.stepKey,
            BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION.StepReleasedReady,
            {
                nextAttemptAt: result.nextAttemptAt,
            },
        );
    }

    private startLeaseRenewal(
        run: BootstrapRunDefinition,
        step: BootstrapStepRecord,
        input: BootstrapStepOrchestratorInput,
    ): () => void {
        const leaseMs = Math.max(1, input.leaseMs);
        const intervalMs = Math.max(1, Math.floor(leaseMs / 3));
        const maxProgressStaleMs = Math.max(
            leaseMs,
            input.maxProgressStaleMs,
        );
        let stopped = false;
        let lastProgressAt = this.nowMs();
        let lastProgressFingerprint = this.observeProgressFingerprint(
            run,
            step,
            input,
        );
        const renew = (): void => {
            if (stopped) {
                return;
            }
            const nowMs = this.nowMs();
            const progressFingerprint = this.observeProgressFingerprint(
                run,
                step,
                input,
            );
            if (progressFingerprint !== lastProgressFingerprint) {
                lastProgressAt = nowMs;
                lastProgressFingerprint = progressFingerprint;
            }
            const staleMs = nowMs - lastProgressAt;
            if (staleMs > maxProgressStaleMs) {
                stopped = true;
                clearInterval(timer);
                this.logWarn(
                    input,
                    run,
                    step.stepKey,
                    BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION
                        .LeaseRenewalProgressStale,
                    {
                        lastProgressAt,
                        staleMs,
                        maxProgressStaleMs,
                        progressFingerprint,
                    },
                );
                return;
            }
            this.stepsPort.renewStepLease({
                runId: run.runId,
                stepKey: step.stepKey,
                leaseOwner: input.leaseOwner,
                leaseUntil: nowMs + leaseMs,
            });
        };
        const timer = setInterval(renew, intervalMs);
        timer.unref?.();
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }

    private observeProgressFingerprint(
        run: BootstrapRunDefinition,
        step: BootstrapStepRecord,
        input: BootstrapStepOrchestratorInput,
    ): string | null {
        try {
            return (
                this.progressObserverPort.observeStepProgress({
                    runId: run.runId,
                    stepKey: step.stepKey,
                })?.fingerprint ?? null
            );
        } catch (error) {
            this.logWarn(
                input,
                run,
                step.stepKey,
                BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION
                    .LeaseRenewalObserveFailed,
                {
                    error: String(error),
                },
            );
            return null;
        }
    }

    private markProcessorException(
        run: BootstrapRunDefinition,
        step: BootstrapStepRecord,
        input: BootstrapStepOrchestratorInput,
        error: unknown,
    ): void {
        this.markRetryOrTerminalFailure(
            run,
            step,
            input,
            BOOTSTRAP_STEP_ORCHESTRATION_ERROR.ProcessorException,
            String(error),
        );
    }

    private markInvalidOutcome(
        run: BootstrapRunDefinition,
        step: BootstrapStepRecord,
        input: BootstrapStepOrchestratorInput,
        code: string,
        message: string,
    ): void {
        this.stepsPort.markStepFailedTerminal({
            runId: step.runId,
            stepKey: step.stepKey,
            attempts: step.attempts + 1,
            error: formatOrchestrationError(code, message),
        });
        this.logError(
            input,
            run,
            step.stepKey,
            BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION.InvalidOutcome,
            {
                attempts: step.attempts + 1,
                errorCode: code,
                error: message,
            },
        );
    }

    private markRetryOrTerminalFailure(
        run: BootstrapRunDefinition,
        step: BootstrapStepRecord,
        input: BootstrapStepOrchestratorInput,
        code: string,
        message: string,
    ): void {
        const attempts = step.attempts + 1;
        if (attempts >= input.retryPolicy.maxAttempts) {
            this.stepsPort.markStepFailedTerminal({
                runId: step.runId,
                stepKey: step.stepKey,
                attempts,
                error: formatOrchestrationError(code, message),
            });
            this.logError(
                input,
                run,
                step.stepKey,
                BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION.StepTerminalFailed,
                {
                    attempts,
                    errorCode: code,
                    error: message,
                },
            );
            return;
        }

        const nextAttemptAt =
            this.nowMs() + getRetryDelayMs(attempts, input.retryPolicy);
        this.stepsPort.markStepFailedRetry({
            runId: step.runId,
            stepKey: step.stepKey,
            attempts,
            nextAttemptAt,
            error: formatOrchestrationError(code, message),
        });
        this.logWarn(
            input,
            run,
            step.stepKey,
            BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION.StepRetryScheduled,
            {
                attempts,
                nextAttemptAt,
                errorCode: code,
                error: message,
            },
        );
    }

    private logDebug(
        input: BootstrapStepOrchestratorInput,
        run: BootstrapRunDefinition,
        stepKey: BootstrapStepKey,
        action: string,
        meta: Record<string, unknown> = {},
    ): void {
        this.loggerPort.debug(BOOTSTRAP_STEP_ORCHESTRATOR_LOG_MESSAGE, {
            ...this.buildLogMeta(input, run, stepKey, action),
            ...meta,
        });
    }

    private logWarn(
        input: BootstrapStepOrchestratorInput,
        run: BootstrapRunDefinition,
        stepKey: BootstrapStepKey,
        action: string,
        meta: Record<string, unknown> = {},
    ): void {
        this.loggerPort.warn(BOOTSTRAP_STEP_ORCHESTRATOR_LOG_MESSAGE, {
            ...this.buildLogMeta(input, run, stepKey, action),
            ...meta,
        });
    }

    private logError(
        input: BootstrapStepOrchestratorInput,
        run: BootstrapRunDefinition,
        stepKey: BootstrapStepKey,
        action: string,
        meta: Record<string, unknown> = {},
    ): void {
        this.loggerPort.error(BOOTSTRAP_STEP_ORCHESTRATOR_LOG_MESSAGE, {
            ...this.buildLogMeta(input, run, stepKey, action),
            ...meta,
        });
    }

    private buildLogMeta(
        input: BootstrapStepOrchestratorInput,
        run: BootstrapRunDefinition,
        stepKey: BootstrapStepKey,
        action: string,
    ): Record<string, unknown> {
        return {
            component: BOOTSTRAP_STEP_ORCHESTRATOR_COMPONENT,
            action,
            traceId: input.traceId,
            laneName: input.laneName,
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            stepKey,
            leaseOwner: input.leaseOwner,
        };
    }
}

// A terminal processor result is convenient for steps that completed or failed themselves.
export function terminalStepResult(): BootstrapClaimedStepProcessorResult {
    return { release: BOOTSTRAP_STEP_PROCESSOR_RELEASE.Terminal };
}

// Releasing as ready lets taskized steps process the next bounded batch later.
export function readyStepResult(
    nextAttemptAt: number,
): BootstrapClaimedStepProcessorResult {
    return {
        release: BOOTSTRAP_STEP_PROCESSOR_RELEASE.Ready,
        nextAttemptAt,
    };
}

// Releasing as running is for work delegated to another durable queue.
export function runningStepResult(
    nextAttemptAt: number,
): BootstrapClaimedStepProcessorResult {
    return {
        release: BOOTSTRAP_STEP_PROCESSOR_RELEASE.Running,
        nextAttemptAt,
    };
}

function formatOrchestrationError(code: string, message: string): string {
    return `${code}: ${message}`;
}
