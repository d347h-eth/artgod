import { describe, expect, it } from "vitest";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    type BootstrapStepKey,
} from "@artgod/shared/bootstrap/pipeline";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { TOKEN_METADATA_IMAGE_SOURCE_FIELD } from "@artgod/shared/media/token-metadata-image-source";
import {
    BootstrapStepScheduler,
    type BootstrapStepSchedulerRunsPort,
    type BootstrapStepSchedulerStepsPort,
} from "../src/application/bootstrap-step-scheduler.js";
import {
    readyStepResult,
    type BootstrapClaimedStepProcessorPort,
    type BootstrapStepWakePort,
} from "../src/application/bootstrap-step-orchestrator.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import type { RetryPolicy } from "../src/domain/retry.js";
import type { BootstrapRunDefinition } from "../src/ports/bootstrap-runs.js";
import type { BootstrapStepRecord } from "../src/ports/bootstrap-steps.js";

const TEST_RETRY_POLICY = {
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
} satisfies RetryPolicy;
const TEST_LANE_NAME = "test_lane";

describe("bootstrap step scheduler", () => {
    it("claims due lane work without a queue wake", async () => {
        let nowMs = 1_000;
        const run = buildRun(51);
        const steps = new InMemoryStepsPort([
            step(run.runId, BOOTSTRAP_STEP_KEY.Metadata),
        ]);
        const scheduler = buildScheduler({
            runs: runsPort([run], []),
            steps,
            nowMs: () => nowMs,
            processor: processorPort(async () => readyStepResult(2_000)),
        });

        const result = await scheduler.runOnce(
            schedulerInput(run.chainId, [BOOTSTRAP_STEP_KEY.Metadata]),
        );

        expect(result.runIds).toEqual([run.runId]);
        expect(result.claimedStepKeys).toEqual([BOOTSTRAP_STEP_KEY.Metadata]);
        expect(steps.getStep(run.runId, BOOTSTRAP_STEP_KEY.Metadata)).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Ready,
                nextAttemptAt: 2_000,
            }),
        );
        nowMs = result.nextDueAt ?? nowMs;
        expect(nowMs).toBe(2_000);
    });

    it("picks up incomplete future work after its durable deadline", async () => {
        let nowMs = 1_000;
        const run = buildRun(52);
        const steps = new InMemoryStepsPort([
            step(run.runId, BOOTSTRAP_STEP_KEY.Metadata),
        ]);
        const claimed: BootstrapStepKey[] = [];
        const scheduler = buildScheduler({
            runs: runsPort([run], []),
            steps,
            nowMs: () => nowMs,
            processor: processorPort(async ({ step }) => {
                claimed.push(step.stepKey);
                return readyStepResult(5_000);
            }),
        });

        await scheduler.runOnce(
            schedulerInput(run.chainId, [BOOTSTRAP_STEP_KEY.Metadata]),
        );
        nowMs = 4_999;
        const early = await scheduler.runOnce(
            schedulerInput(run.chainId, [BOOTSTRAP_STEP_KEY.Metadata]),
        );
        nowMs = 5_000;
        const due = await scheduler.runOnce(
            schedulerInput(run.chainId, [BOOTSTRAP_STEP_KEY.Metadata]),
        );

        expect(early.claimedStepKeys).toEqual([]);
        expect(due.claimedStepKeys).toEqual([BOOTSTRAP_STEP_KEY.Metadata]);
        expect(claimed).toEqual([
            BOOTSTRAP_STEP_KEY.Metadata,
            BOOTSTRAP_STEP_KEY.Metadata,
        ]);
    });

    it("does not strand due lane work after bounded iteration exhaustion", async () => {
        const run = buildRun(53);
        const steps = new InMemoryStepsPort([
            step(run.runId, BOOTSTRAP_STEP_KEY.Metadata),
            step(run.runId, BOOTSTRAP_STEP_KEY.Ownership),
        ]);
        const scheduler = buildScheduler({
            runs: runsPort([run], []),
            steps,
            nowMs: () => 1_000,
            processor: processorPort(async ({ step }) =>
                step.stepKey === BOOTSTRAP_STEP_KEY.Metadata
                    ? readyStepResult(10_000)
                    : readyStepResult(2_000),
            ),
        });
        const input = schedulerInput(run.chainId, [
            BOOTSTRAP_STEP_KEY.Metadata,
            BOOTSTRAP_STEP_KEY.Ownership,
        ]);

        const first = await scheduler.runOnce(input);
        const second = await scheduler.runOnce(input);

        expect(first.claimedStepKeys).toEqual([BOOTSTRAP_STEP_KEY.Metadata]);
        expect(second.claimedStepKeys).toEqual([BOOTSTRAP_STEP_KEY.Ownership]);
    });

    it("does not claim paused ownership work during startup sweep", async () => {
        const run = buildRun(56);
        const steps = new InMemoryStepsPort([
            step(
                run.runId,
                BOOTSTRAP_STEP_KEY.Ownership,
                BOOTSTRAP_STEP_STATUS.Paused,
            ),
        ]);
        const scheduler = buildScheduler({
            runs: runsPort([run], [run]),
            steps,
            nowMs: () => 1_000,
            processor: processorPort(async () => readyStepResult(2_000)),
        });

        const result = await scheduler.runOnce(
            schedulerInput(run.chainId, [BOOTSTRAP_STEP_KEY.Ownership]),
        );

        expect(result.runIds).toEqual([run.runId]);
        expect(result.claimedStepKeys).toEqual([]);
        expect(steps.isStepPaused(run.runId, BOOTSTRAP_STEP_KEY.Ownership)).toBe(
            true,
        );
    });

    it("prioritizes due rows before startup sweep candidates", async () => {
        const dueRun = buildRun(54);
        const startupRun = buildRun(55);
        const steps = new InMemoryStepsPort([
            step(dueRun.runId, BOOTSTRAP_STEP_KEY.Metadata),
            step(
                startupRun.runId,
                BOOTSTRAP_STEP_KEY.Metadata,
                BOOTSTRAP_STEP_STATUS.Pending,
            ),
        ]);
        const scheduler = buildScheduler({
            runs: runsPort([dueRun, startupRun], [startupRun]),
            steps,
            nowMs: () => 1_000,
            processor: processorPort(async () => readyStepResult(2_000)),
        });

        const result = await scheduler.runOnce(
            schedulerInput(dueRun.chainId, [BOOTSTRAP_STEP_KEY.Metadata], {
                runLimit: 1,
            }),
        );

        expect(result.runIds).toEqual([dueRun.runId]);
        expect(result.claimedStepKeys).toEqual([BOOTSTRAP_STEP_KEY.Metadata]);
    });
});

function buildScheduler(input: {
    runs: BootstrapStepSchedulerRunsPort;
    steps: BootstrapStepSchedulerStepsPort;
    processor: BootstrapClaimedStepProcessorPort;
    nowMs: () => number;
}): BootstrapStepScheduler {
    return new BootstrapStepScheduler(
        input.runs,
        input.steps,
        input.processor,
        wakePort(),
        input.nowMs,
    );
}

function schedulerInput(
    chainId: number,
    laneStepKeys: readonly BootstrapStepKey[],
    options: { runLimit?: number } = {},
) {
    return {
        chainId,
        traceId: "scheduler-test",
        laneName: TEST_LANE_NAME,
        laneStepKeys,
        leaseOwner: "scheduler-test-lease",
        leaseMs: 1_000,
        maxProgressStaleMs: 30_000,
        claimLimit: 1,
        maxIterationsPerRun: 1,
        runLimit: options.runLimit ?? 10,
        retryPolicy: TEST_RETRY_POLICY,
    };
}

function runsPort(
    runs: BootstrapRunDefinition[],
    startupRuns: BootstrapRunDefinition[],
): BootstrapStepSchedulerRunsPort {
    return {
        getRun: (runId) => runs.find((run) => run.runId === runId) ?? null,
        listRunsForStartupSweep: () => startupRuns,
    };
}

function processorPort(
    processClaimedStep: BootstrapClaimedStepProcessorPort["processClaimedStep"],
): BootstrapClaimedStepProcessorPort {
    return { processClaimedStep };
}

function wakePort(): BootstrapStepWakePort {
    return {
        wakeBootstrapStep: async () => {},
    };
}

class InMemoryStepsPort implements BootstrapStepSchedulerStepsPort {
    constructor(private readonly steps: BootstrapStepRecord[]) {}

    getStep(
        runId: number,
        stepKey: BootstrapStepKey,
    ): BootstrapStepRecord | null {
        return (
            this.steps.find(
                (stepItem) =>
                    stepItem.runId === runId && stepItem.stepKey === stepKey,
            ) ?? null
        );
    }

    listRunSteps(runId: number): BootstrapStepRecord[] {
        return this.steps.filter((stepItem) => stepItem.runId === runId);
    }

    listDueStepRunIds(input: {
        stepKeys: readonly BootstrapStepKey[];
        nowMs: number;
        limit: number;
    }): number[] {
        const runIds = new Set<number>();
        for (const stepItem of this.steps) {
            if (runIds.size >= input.limit) {
                break;
            }
            if (isDueStep(stepItem, input.stepKeys, input.nowMs)) {
                runIds.add(stepItem.runId);
            }
        }
        return [...runIds];
    }

    getNextDueStepAt(input: {
        stepKeys: readonly BootstrapStepKey[];
    }): number | null {
        const dueTimes = this.steps
            .filter(
                (stepItem) =>
                    input.stepKeys.includes(stepItem.stepKey) &&
                    isDeadlineTrackedStep(stepItem),
            )
            .map((stepItem) =>
                stepItem.status === BOOTSTRAP_STEP_STATUS.Running
                    ? stepItem.leaseUntil
                    : stepItem.nextAttemptAt,
            )
            .filter((value): value is number => value !== null);
        return dueTimes.length > 0 ? Math.min(...dueTimes) : null;
    }

    markStepReady(runId: number, stepKey: BootstrapStepKey): void {
        const target = this.getStep(runId, stepKey);
        if (target) {
            target.status = BOOTSTRAP_STEP_STATUS.Ready;
            target.nextAttemptAt = 0;
        }
    }

    claimReadySteps(input: {
        stepKeys: readonly BootstrapStepKey[];
        leaseOwner: string;
        leaseUntil: number;
        nowMs: number;
        limit: number;
    }): BootstrapStepRecord[] {
        const result: BootstrapStepRecord[] = [];
        for (const stepItem of this.steps) {
            if (result.length >= input.limit) {
                break;
            }
            if (!isDueStep(stepItem, input.stepKeys, input.nowMs)) {
                continue;
            }
            stepItem.status = BOOTSTRAP_STEP_STATUS.Running;
            stepItem.leaseOwner = input.leaseOwner;
            stepItem.leaseUntil = input.leaseUntil;
            result.push({ ...stepItem });
        }
        return result;
    }

    releaseStepLease(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        nextAttemptAt: number;
    }): void {
        const target = this.getStep(input.runId, input.stepKey);
        if (target) {
            target.status = BOOTSTRAP_STEP_STATUS.Ready;
            target.nextAttemptAt = input.nextAttemptAt;
            target.leaseOwner = null;
            target.leaseUntil = null;
        }
    }

    releaseStepLeaseAsRunning(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        nextAttemptAt: number;
    }): void {
        const target = this.getStep(input.runId, input.stepKey);
        if (target) {
            target.status = BOOTSTRAP_STEP_STATUS.Running;
            target.nextAttemptAt = input.nextAttemptAt;
            target.leaseOwner = null;
            target.leaseUntil = input.nextAttemptAt;
        }
    }

    renewStepLease(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        leaseOwner: string;
        leaseUntil: number;
    }): void {
        const target = this.getStep(input.runId, input.stepKey);
        if (target && target.leaseOwner === input.leaseOwner) {
            target.leaseUntil = input.leaseUntil;
        }
    }

    markStepRunning(runId: number, stepKey: BootstrapStepKey): void {
        const target = this.getStep(runId, stepKey);
        if (target) {
            target.status = BOOTSTRAP_STEP_STATUS.Running;
        }
    }

    markStepSucceeded(runId: number, stepKey: BootstrapStepKey): void {
        const target = this.getStep(runId, stepKey);
        if (target) {
            target.status = BOOTSTRAP_STEP_STATUS.Succeeded;
            target.leaseOwner = null;
            target.leaseUntil = null;
        }
    }

    markStepSkipped(runId: number, stepKey: BootstrapStepKey): void {
        const target = this.getStep(runId, stepKey);
        if (target) {
            target.status = BOOTSTRAP_STEP_STATUS.Skipped;
            target.leaseOwner = null;
            target.leaseUntil = null;
        }
    }

    markStepFailedRetry(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        attempts: number;
        nextAttemptAt: number;
        error: string;
    }): void {
        const target = this.getStep(input.runId, input.stepKey);
        if (target) {
            target.status = BOOTSTRAP_STEP_STATUS.FailedRetry;
            target.attempts = input.attempts;
            target.nextAttemptAt = input.nextAttemptAt;
            target.lastError = input.error;
            target.leaseOwner = null;
            target.leaseUntil = null;
        }
    }

    markStepFailedTerminal(input: {
        runId: number;
        stepKey: BootstrapStepKey;
        attempts: number;
        error: string;
    }): void {
        const target = this.getStep(input.runId, input.stepKey);
        if (target) {
            target.status = BOOTSTRAP_STEP_STATUS.FailedTerminal;
            target.attempts = input.attempts;
            target.lastError = input.error;
            target.leaseOwner = null;
            target.leaseUntil = null;
        }
    }

    updateStepProgress(): void {}

    isStepPaused(runId: number, stepKey: BootstrapStepKey): boolean {
        return (
            this.getStep(runId, stepKey)?.status ===
            BOOTSTRAP_STEP_STATUS.Paused
        );
    }
}

function isDeadlineTrackedStep(stepItem: BootstrapStepRecord): boolean {
    return (
        stepItem.status === BOOTSTRAP_STEP_STATUS.Ready ||
        stepItem.status === BOOTSTRAP_STEP_STATUS.FailedRetry ||
        stepItem.status === BOOTSTRAP_STEP_STATUS.Running
    );
}

function isDueStep(
    stepItem: BootstrapStepRecord,
    stepKeys: readonly BootstrapStepKey[],
    nowMs: number,
): boolean {
    if (!stepKeys.includes(stepItem.stepKey)) {
        return false;
    }
    if (
        stepItem.status === BOOTSTRAP_STEP_STATUS.Ready ||
        stepItem.status === BOOTSTRAP_STEP_STATUS.FailedRetry
    ) {
        return (
            stepItem.nextAttemptAt <= nowMs &&
            (stepItem.leaseUntil === null || stepItem.leaseUntil <= nowMs)
        );
    }
    return (
        stepItem.status === BOOTSTRAP_STEP_STATUS.Running &&
        stepItem.leaseUntil !== null &&
        stepItem.leaseUntil <= nowMs
    );
}

function step(
    runId: number,
    stepKey: BootstrapStepKey,
    status: BootstrapStepRecord["status"] = BOOTSTRAP_STEP_STATUS.Ready,
): BootstrapStepRecord {
    return {
        runId,
        stepKey,
        status,
        blocking: true,
        dependsOn: [],
        nextAttemptAt: 0,
        leaseOwner: null,
        leaseUntil: null,
        progressCompleted: 0,
        progressTotal: null,
        resultJson: null,
        attempts: 0,
        lastError: null,
    };
}

function buildRun(runId: number): BootstrapRunDefinition {
    return {
        runId,
        chainId: 1,
        collectionId: runId,
        requestSlug: `collection-${runId}`,
        requestAddress: "0x0000000000000000000000000000000000000001",
        requestStandard: COLLECTION_STANDARD.Erc721,
        imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
        animationSourceField: null,
        requestExtensionKey: null,
        metadataMode: BOOTSTRAP_METADATA_MODE.BestEffort,
        enumerationMode: BOOTSTRAP_ENUMERATION_MODE.Enumerable,
        manualTokenIdsJson: null,
        manualRangeStartTokenId: null,
        manualRangeTotalSupply: null,
        imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
        imageCacheMaxDimension: 1024,
        deploymentBlock: null,
        status: BOOTSTRAP_RUN_STATUS.Metadata,
        anchorBlock: 24500000,
        anchorBlockHash:
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        anchorBlockTimestamp: 1726000000,
    };
}
