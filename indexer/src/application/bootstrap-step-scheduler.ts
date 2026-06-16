import type { BootstrapStepKey } from "@artgod/shared/bootstrap/pipeline";
import type { RetryPolicy } from "../domain/retry.js";
import type { BootstrapRunDefinition } from "../ports/bootstrap-runs.js";
import {
    BootstrapStepOrchestrator,
    type BootstrapClaimedStepProcessorPort,
    type BootstrapStepOrchestratorRunsPort,
    type BootstrapStepOrchestratorStepsPort,
    type BootstrapStepWakePort,
} from "./bootstrap-step-orchestrator.js";

export type BootstrapStepSchedulerInput = {
    chainId: number;
    runId?: number | null;
    traceId: string;
    laneName: string;
    laneStepKeys: readonly BootstrapStepKey[];
    leaseOwner: string;
    leaseMs: number;
    claimLimit: number;
    maxIterationsPerRun: number;
    runLimit: number;
    retryPolicy: RetryPolicy;
};

export type BootstrapStepSchedulerResult = {
    chainId: number;
    runIds: number[];
    claimedStepKeys: BootstrapStepKey[];
    readyStepKeys: BootstrapStepKey[];
    wakeStepKeys: BootstrapStepKey[];
    nextDueAt: number | null;
};

export interface BootstrapStepSchedulerRunsPort
    extends BootstrapStepOrchestratorRunsPort {
    listRunsForStartupSweep(
        chainId: number,
        limit: number,
    ): BootstrapRunDefinition[];
}

export interface BootstrapStepSchedulerStepsPort
    extends BootstrapStepOrchestratorStepsPort {
    listDueStepRunIds(input: {
        chainId: number;
        stepKeys: readonly BootstrapStepKey[];
        nowMs: number;
        limit: number;
    }): number[];
    getNextDueStepAt(input: {
        chainId: number;
        stepKeys: readonly BootstrapStepKey[];
    }): number | null;
}

// Scheduler pass that discovers lane work from durable step state, then delegates execution.
export class BootstrapStepScheduler {
    private readonly orchestrator: BootstrapStepOrchestrator;

    constructor(
        private readonly runsPort: BootstrapStepSchedulerRunsPort,
        private readonly stepsPort: BootstrapStepSchedulerStepsPort,
        processorPort: BootstrapClaimedStepProcessorPort,
        wakePort: BootstrapStepWakePort,
        private readonly nowMs: () => number = Date.now,
    ) {
        this.orchestrator = new BootstrapStepOrchestrator(
            runsPort,
            stepsPort,
            processorPort,
            wakePort,
            nowMs,
        );
    }

    async runOnce(
        input: BootstrapStepSchedulerInput,
    ): Promise<BootstrapStepSchedulerResult> {
        const runIds = this.collectRunIds(input);
        const claimedStepKeys: BootstrapStepKey[] = [];
        const readyStepKeys: BootstrapStepKey[] = [];
        const wakeStepKeys: BootstrapStepKey[] = [];

        for (const runId of runIds) {
            const result = await this.orchestrator.run({
                runId,
                traceId: input.traceId,
                laneName: input.laneName,
                laneStepKeys: input.laneStepKeys,
                leaseOwner: input.leaseOwner,
                leaseMs: input.leaseMs,
                claimLimit: input.claimLimit,
                maxIterations: input.maxIterationsPerRun,
                retryPolicy: input.retryPolicy,
            });
            claimedStepKeys.push(...result.claimedStepKeys);
            readyStepKeys.push(...result.readyStepKeys);
            wakeStepKeys.push(...result.wakeStepKeys);
        }

        return {
            chainId: input.chainId,
            runIds,
            claimedStepKeys,
            readyStepKeys,
            wakeStepKeys,
            nextDueAt: this.stepsPort.getNextDueStepAt({
                chainId: input.chainId,
                stepKeys: input.laneStepKeys,
            }),
        };
    }

    private collectRunIds(input: BootstrapStepSchedulerInput): number[] {
        const limit = Math.max(1, input.runLimit);
        const runIds = new Set<number>();
        if (input.runId !== undefined && input.runId !== null) {
            runIds.add(input.runId);
        }

        if (runIds.size < limit) {
            for (const runId of this.stepsPort.listDueStepRunIds({
                chainId: input.chainId,
                stepKeys: input.laneStepKeys,
                nowMs: this.nowMs(),
                limit,
            })) {
                runIds.add(runId);
                if (runIds.size >= limit) {
                    break;
                }
            }
        }

        if (runIds.size < limit) {
            for (const run of this.runsPort.listRunsForStartupSweep(
                input.chainId,
                limit,
            )) {
                runIds.add(run.runId);
                if (runIds.size >= limit) {
                    break;
                }
            }
        }

        return [...runIds];
    }
}
