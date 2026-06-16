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
import {
    BOOTSTRAP_STEP_ORCHESTRATION_ERROR,
    BootstrapStepOrchestrator,
    readyStepResult,
    terminalStepResult,
    type BootstrapClaimedStepProcessorPort,
    type BootstrapStepOrchestratorRunsPort,
    type BootstrapStepOrchestratorStepsPort,
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

describe("bootstrap step orchestrator", () => {
    it("claims in-lane ready steps and wakes out-of-lane ready steps", async () => {
        const run = buildRun();
        const steps = [
            step(BOOTSTRAP_STEP_KEY.Metadata, BOOTSTRAP_STEP_STATUS.Succeeded),
            step(BOOTSTRAP_STEP_KEY.Ownership, BOOTSTRAP_STEP_STATUS.Pending, [
                BOOTSTRAP_STEP_KEY.Metadata,
            ]),
            step(BOOTSTRAP_STEP_KEY.ImageCache, BOOTSTRAP_STEP_STATUS.Pending, [
                BOOTSTRAP_STEP_KEY.Metadata,
            ]),
        ];
        const claimed: BootstrapStepKey[] = [];
        const released: Array<{ stepKey: BootstrapStepKey; nextAttemptAt: number }> =
            [];
        const woken: BootstrapStepKey[] = [];
        const orchestrator = new BootstrapStepOrchestrator(
            runsPort(run),
            stepsPort(steps, claimed, released),
            processorPort(async ({ step }) => {
                if (step.stepKey === BOOTSTRAP_STEP_KEY.Ownership) {
                    return readyStepResult(1234);
                }
                return terminalStepResult();
            }),
            wakePort(woken),
        );

        const result = await orchestrator.run({
            runId: run.runId,
            traceId: "trace-test",
            laneStepKeys: [BOOTSTRAP_STEP_KEY.Ownership],
            leaseOwner: "lease-test",
            leaseMs: 1_000,
            claimLimit: 1,
            maxIterations: 1,
            retryPolicy: TEST_RETRY_POLICY,
        });

        expect(result.readyStepKeys).toEqual([
            BOOTSTRAP_STEP_KEY.Ownership,
            BOOTSTRAP_STEP_KEY.ImageCache,
        ]);
        expect(result.claimedStepKeys).toEqual([BOOTSTRAP_STEP_KEY.Ownership]);
        expect(woken).toEqual([BOOTSTRAP_STEP_KEY.ImageCache]);
        expect(claimed).toEqual([BOOTSTRAP_STEP_KEY.Ownership]);
        expect(released).toEqual([
            { stepKey: BOOTSTRAP_STEP_KEY.Ownership, nextAttemptAt: 1234 },
        ]);
    });

    it("releases processor exceptions into retry state and clears the lease", async () => {
        const run = buildRun();
        const steps = [
            step(BOOTSTRAP_STEP_KEY.Metadata, BOOTSTRAP_STEP_STATUS.Ready),
        ];
        const failures: Array<{
            stepKey: BootstrapStepKey;
            attempts: number;
            nextAttemptAt: number;
            error: string;
        }> = [];
        const orchestrator = new BootstrapStepOrchestrator(
            runsPort(run),
            stepsPort(steps, [], [], failures),
            processorPort(async () => {
                throw new Error("metadata exploded");
            }),
            wakePort([]),
        );

        await orchestrator.run({
            runId: run.runId,
            traceId: "trace-test",
            laneStepKeys: [BOOTSTRAP_STEP_KEY.Metadata],
            leaseOwner: "lease-test",
            leaseMs: 1_000,
            claimLimit: 1,
            maxIterations: 1,
            retryPolicy: TEST_RETRY_POLICY,
        });

        expect(failures).toEqual([
            expect.objectContaining({
                stepKey: BOOTSTRAP_STEP_KEY.Metadata,
                attempts: 1,
                error: expect.stringContaining(
                    BOOTSTRAP_STEP_ORCHESTRATION_ERROR.ProcessorException,
                ),
            }),
        ]);
        expect(steps[0]).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.FailedRetry,
                leaseOwner: null,
                leaseUntil: null,
            }),
        );
    });

    it("marks invalid terminal outcomes as orchestration failures", async () => {
        const run = buildRun();
        const steps = [
            step(BOOTSTRAP_STEP_KEY.Metadata, BOOTSTRAP_STEP_STATUS.Ready),
        ];
        const terminalFailures: Array<{
            stepKey: BootstrapStepKey;
            attempts: number;
            error: string;
        }> = [];
        const orchestrator = new BootstrapStepOrchestrator(
            runsPort(run),
            stepsPort(steps, [], [], [], terminalFailures),
            processorPort(async () => terminalStepResult()),
            wakePort([]),
        );

        await orchestrator.run({
            runId: run.runId,
            traceId: "trace-test",
            laneStepKeys: [BOOTSTRAP_STEP_KEY.Metadata],
            leaseOwner: "lease-test",
            leaseMs: 1_000,
            claimLimit: 1,
            maxIterations: 1,
            retryPolicy: TEST_RETRY_POLICY,
        });

        expect(terminalFailures).toEqual([
            expect.objectContaining({
                stepKey: BOOTSTRAP_STEP_KEY.Metadata,
                attempts: 1,
                error: expect.stringContaining(
                    BOOTSTRAP_STEP_ORCHESTRATION_ERROR.InvalidTerminalOutcome,
                ),
            }),
        ]);
        expect(steps[0]?.status).toBe(BOOTSTRAP_STEP_STATUS.FailedTerminal);
    });
});

function runsPort(
    run: BootstrapRunDefinition,
): BootstrapStepOrchestratorRunsPort {
    return {
        getRun: (runId) => (runId === run.runId ? run : null),
    };
}

function stepsPort(
    steps: BootstrapStepRecord[],
    claimed: BootstrapStepKey[],
    released: Array<{ stepKey: BootstrapStepKey; nextAttemptAt: number }>,
    failures: Array<{
        stepKey: BootstrapStepKey;
        attempts: number;
        nextAttemptAt: number;
        error: string;
    }> = [],
    terminalFailures: Array<{
        stepKey: BootstrapStepKey;
        attempts: number;
        error: string;
    }> = [],
): BootstrapStepOrchestratorStepsPort {
    return {
        listRunSteps: () => steps,
        markStepReady: (_runId, stepKey) => {
            const target = steps.find((stepItem) => stepItem.stepKey === stepKey);
            if (target) {
                target.status = BOOTSTRAP_STEP_STATUS.Ready;
            }
        },
        claimReadySteps: ({ stepKeys, leaseOwner, leaseUntil, nowMs, limit }) => {
            const result: BootstrapStepRecord[] = [];
            for (const stepItem of steps) {
                if (result.length >= limit) {
                    break;
                }
                if (
                    !stepKeys.includes(stepItem.stepKey) ||
                    stepItem.status !== BOOTSTRAP_STEP_STATUS.Ready ||
                    stepItem.nextAttemptAt > nowMs
                ) {
                    continue;
                }
                stepItem.status = BOOTSTRAP_STEP_STATUS.Running;
                stepItem.leaseOwner = leaseOwner;
                stepItem.leaseUntil = leaseUntil;
                claimed.push(stepItem.stepKey);
                result.push({ ...stepItem });
            }
            return result;
        },
        releaseStepLease: ({ stepKey, nextAttemptAt }) => {
            const target = steps.find((stepItem) => stepItem.stepKey === stepKey);
            if (target) {
                target.status = BOOTSTRAP_STEP_STATUS.Ready;
                target.nextAttemptAt = nextAttemptAt;
                target.leaseOwner = null;
                target.leaseUntil = null;
            }
            released.push({ stepKey, nextAttemptAt });
        },
        releaseStepLeaseAsRunning: () => {},
        markStepFailedRetry: ({ stepKey, attempts, nextAttemptAt, error }) => {
            const target = steps.find((stepItem) => stepItem.stepKey === stepKey);
            if (target) {
                target.status = BOOTSTRAP_STEP_STATUS.FailedRetry;
                target.attempts = attempts;
                target.nextAttemptAt = nextAttemptAt;
                target.leaseOwner = null;
                target.leaseUntil = null;
                target.lastError = error;
            }
            failures.push({ stepKey, attempts, nextAttemptAt, error });
        },
        markStepFailedTerminal: ({ stepKey, attempts, error }) => {
            const target = steps.find((stepItem) => stepItem.stepKey === stepKey);
            if (target) {
                target.status = BOOTSTRAP_STEP_STATUS.FailedTerminal;
                target.attempts = attempts;
                target.leaseOwner = null;
                target.leaseUntil = null;
                target.lastError = error;
            }
            terminalFailures.push({ stepKey, attempts, error });
        },
    };
}

function processorPort(
    processClaimedStep: BootstrapClaimedStepProcessorPort["processClaimedStep"],
): BootstrapClaimedStepProcessorPort {
    return { processClaimedStep };
}

function wakePort(woken: BootstrapStepKey[]): BootstrapStepWakePort {
    return {
        wakeBootstrapStep: async ({ stepKey }) => {
            woken.push(stepKey);
        },
    };
}

function step(
    stepKey: BootstrapStepKey,
    status: BootstrapStepRecord["status"],
    dependsOn: BootstrapStepKey[] = [],
): BootstrapStepRecord {
    return {
        runId: 41,
        stepKey,
        status,
        blocking: true,
        dependsOn,
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

function buildRun(): BootstrapRunDefinition {
    return {
        runId: 41,
        chainId: 1,
        collectionId: 7,
        requestSlug: "milady-by-remilia-corporation",
        requestAddress: "0x0000000000000000000000000000000000000001",
        requestStandard: COLLECTION_STANDARD.Erc721,
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
