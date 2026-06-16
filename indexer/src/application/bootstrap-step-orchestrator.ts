import {
    isBootstrapStepTerminalStatus,
    type BootstrapStepKey,
} from "@artgod/shared/bootstrap/pipeline";
import { getRetryDelayMs, type RetryPolicy } from "../domain/retry.js";
import type { BootstrapRunDefinition } from "../ports/bootstrap-runs.js";
import type { BootstrapStepRecord } from "../ports/bootstrap-steps.js";
import { resolveReadyBootstrapSteps } from "./bootstrap-step-reconciler.js";

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
    InvalidTerminalOutcome: "invalid_terminal_outcome",
    InvalidRunningOutcome: "invalid_running_outcome",
} as const;

export type BootstrapStepOrchestratorInput = {
    runId: number;
    traceId: string;
    laneStepKeys: readonly BootstrapStepKey[];
    leaseOwner: string;
    leaseMs: number;
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

// Reconciles dependencies, claims due steps with leases, and executes bounded processors.
export class BootstrapStepOrchestrator {
    constructor(
        private readonly runsPort: BootstrapStepOrchestratorRunsPort,
        private readonly stepsPort: BootstrapStepOrchestratorStepsPort,
        private readonly processorPort: BootstrapClaimedStepProcessorPort,
        private readonly wakePort: BootstrapStepWakePort,
        private readonly nowMs: () => number = Date.now,
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
            const claimedSteps = this.stepsPort.claimReadySteps({
                runId: input.runId,
                stepKeys: input.laneStepKeys,
                leaseOwner: input.leaseOwner,
                leaseUntil: nowMs + Math.max(1, input.leaseMs),
                nowMs,
                limit: Math.max(1, input.claimLimit),
            });
            if (claimedSteps.length === 0) {
                break;
            }

            for (const step of claimedSteps) {
                claimedStepKeys.push(step.stepKey);
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
            if (!input.laneStepKeys.includes(stepKey)) {
                wakeStepKeys.push(stepKey);
                await this.wakePort.wakeBootstrapStep({
                    run,
                    stepKey,
                    traceId: input.traceId,
                });
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
        try {
            result = await this.processorPort.processClaimedStep({
                run,
                step,
                leaseOwner: input.leaseOwner,
                traceId: input.traceId,
            });
        } catch (error) {
            this.markProcessorException(step, input, error);
            return;
        }
        const currentStep = this.stepsPort
            .listRunSteps(run.runId)
            .find((candidate) => candidate.stepKey === step.stepKey);
        if (
            currentStep &&
            isBootstrapStepTerminalStatus(currentStep.status)
        ) {
            return;
        }
        if (result.release === BOOTSTRAP_STEP_PROCESSOR_RELEASE.Terminal) {
            this.markInvalidOutcome(
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
            return;
        }
        this.stepsPort.releaseStepLease({
            runId: run.runId,
            stepKey: step.stepKey,
            leaseOwner: input.leaseOwner,
            nextAttemptAt: result.nextAttemptAt,
        });
    }

    private markProcessorException(
        step: BootstrapStepRecord,
        input: BootstrapStepOrchestratorInput,
        error: unknown,
    ): void {
        this.markRetryOrTerminalFailure(
            step,
            input,
            BOOTSTRAP_STEP_ORCHESTRATION_ERROR.ProcessorException,
            String(error),
        );
    }

    private markInvalidOutcome(
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
    }

    private markRetryOrTerminalFailure(
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
            return;
        }

        this.stepsPort.markStepFailedRetry({
            runId: step.runId,
            stepKey: step.stepKey,
            attempts,
            nextAttemptAt:
                this.nowMs() + getRetryDelayMs(attempts, input.retryPolicy),
            error: formatOrchestrationError(code, message),
        });
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
