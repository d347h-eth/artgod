import type { BootstrapStepKey } from "@artgod/shared/bootstrap/pipeline";
import type { BootstrapRunDefinition } from "../ports/bootstrap-runs.js";
import type { BootstrapStepRecord } from "../ports/bootstrap-steps.js";
import {
    resolveReadyBootstrapSteps,
    resolveWakeableBootstrapSteps,
} from "./bootstrap-step-reconciler.js";

// Startup reconciliation outcomes are emitted by the worker for restart diagnostics.
export const BOOTSTRAP_STARTUP_RECONCILE_OUTCOME = {
    Woke: "woke",
    Idle: "idle",
    NoSteps: "no_steps",
    Failed: "failed",
} as const;

export type BootstrapStartupReconcileOutcome =
    (typeof BOOTSTRAP_STARTUP_RECONCILE_OUTCOME)[keyof typeof BOOTSTRAP_STARTUP_RECONCILE_OUTCOME];

export type BootstrapStartupReconcileInput = {
    chainId: number;
    limit: number;
    traceId: string;
};

export type BootstrapStartupReconcileRunResult = {
    run: BootstrapRunDefinition;
    outcome: BootstrapStartupReconcileOutcome;
    readyStepKeys: BootstrapStepKey[];
    wakeableStepKeys: BootstrapStepKey[];
    error: string | null;
};

export type BootstrapStartupReconcileResult = {
    chainId: number;
    limit: number;
    runs: BootstrapStartupReconcileRunResult[];
};

export interface BootstrapStartupRunsPort {
    listRunsForStartupSweep(
        chainId: number,
        limit: number,
    ): BootstrapRunDefinition[];
}

export interface BootstrapStartupStepsPort {
    listRunSteps(runId: number): BootstrapStepRecord[];
    markStepReady(runId: number, stepKey: BootstrapStepKey): void;
}

export interface BootstrapStartupWakePort {
    wakeBootstrapStep(input: {
        run: BootstrapRunDefinition;
        stepKey: BootstrapStepKey;
        traceId: string;
    }): Promise<void>;
}

// Reconciles persisted bootstrap step state into executor wake-ups after runtime restart.
export class BootstrapStartupReconciler {
    constructor(
        private readonly runsPort: BootstrapStartupRunsPort,
        private readonly stepsPort: BootstrapStartupStepsPort,
        private readonly wakePort: BootstrapStartupWakePort,
    ) {}

    async reconcile(
        input: BootstrapStartupReconcileInput,
    ): Promise<BootstrapStartupReconcileResult> {
        const runs = this.runsPort.listRunsForStartupSweep(
            input.chainId,
            input.limit,
        );
        const results: BootstrapStartupReconcileRunResult[] = [];
        for (const run of runs) {
            results.push(await this.reconcileRun(run, input.traceId));
        }
        return {
            chainId: input.chainId,
            limit: input.limit,
            runs: results,
        };
    }

    private async reconcileRun(
        run: BootstrapRunDefinition,
        traceId: string,
    ): Promise<BootstrapStartupReconcileRunResult> {
        const steps = this.stepsPort.listRunSteps(run.runId);
        if (steps.length === 0) {
            return buildResult({
                run,
                outcome: BOOTSTRAP_STARTUP_RECONCILE_OUTCOME.NoSteps,
            });
        }

        const readyStepKeys = resolveReadyBootstrapSteps(steps);
        const wakeableStepKeys = resolveWakeableBootstrapSteps(
            steps,
            readyStepKeys,
        );
        try {
            for (const stepKey of readyStepKeys) {
                this.stepsPort.markStepReady(run.runId, stepKey);
            }
            for (const stepKey of wakeableStepKeys) {
                await this.wakePort.wakeBootstrapStep({
                    run,
                    stepKey,
                    traceId,
                });
            }
        } catch (error) {
            return buildResult({
                run,
                outcome: BOOTSTRAP_STARTUP_RECONCILE_OUTCOME.Failed,
                readyStepKeys,
                wakeableStepKeys,
                error: String(error),
            });
        }

        return buildResult({
            run,
            outcome:
                wakeableStepKeys.length > 0
                    ? BOOTSTRAP_STARTUP_RECONCILE_OUTCOME.Woke
                    : BOOTSTRAP_STARTUP_RECONCILE_OUTCOME.Idle,
            readyStepKeys,
            wakeableStepKeys,
        });
    }
}

function buildResult(input: {
    run: BootstrapRunDefinition;
    outcome: BootstrapStartupReconcileOutcome;
    readyStepKeys?: BootstrapStepKey[];
    wakeableStepKeys?: BootstrapStepKey[];
    error?: string | null;
}): BootstrapStartupReconcileRunResult {
    return {
        run: input.run,
        outcome: input.outcome,
        readyStepKeys: input.readyStepKeys ?? [],
        wakeableStepKeys: input.wakeableStepKeys ?? [],
        error: input.error ?? null,
    };
}
