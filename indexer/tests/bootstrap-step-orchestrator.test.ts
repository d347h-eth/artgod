import { describe, expect, it } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
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
    BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION,
    BOOTSTRAP_STEP_ORCHESTRATION_ERROR,
    BootstrapStepOrchestrator,
    readyStepResult,
    runningStepResult,
    terminalStepResult,
    type BootstrapClaimedStepProcessorPort,
    type BootstrapStepProgressObserverPort,
    type BootstrapStepOrchestratorLoggerPort,
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
const TEST_TRACE_ID = "trace-test";
const TEST_LANE_NAME = "test_lane";
const TEST_LEASE_OWNER = "lease-test";
const TEST_LOG_LEVEL = {
    Debug: "debug",
    Warn: "warn",
    Error: "error",
} as const;

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
            traceId: TEST_TRACE_ID,
            laneName: TEST_LANE_NAME,
            laneStepKeys: [BOOTSTRAP_STEP_KEY.Ownership],
            leaseOwner: TEST_LEASE_OWNER,
            leaseMs: 1_000,
            maxProgressStaleMs: 30_000,
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
            traceId: TEST_TRACE_ID,
            laneName: TEST_LANE_NAME,
            laneStepKeys: [BOOTSTRAP_STEP_KEY.Metadata],
            leaseOwner: TEST_LEASE_OWNER,
            leaseMs: 1_000,
            maxProgressStaleMs: 30_000,
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
            traceId: TEST_TRACE_ID,
            laneName: TEST_LANE_NAME,
            laneStepKeys: [BOOTSTRAP_STEP_KEY.Metadata],
            leaseOwner: TEST_LEASE_OWNER,
            leaseMs: 1_000,
            maxProgressStaleMs: 30_000,
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

    it("observes a paused step without terminalizing stale processor output", async () => {
        const run = buildRun();
        const steps = [
            step(BOOTSTRAP_STEP_KEY.Ownership, BOOTSTRAP_STEP_STATUS.Ready),
        ];
        const terminalFailures: Array<{
            stepKey: BootstrapStepKey;
            attempts: number;
            error: string;
        }> = [];
        const logs = createLogCapture();
        const orchestrator = new BootstrapStepOrchestrator(
            runsPort(run),
            stepsPort(steps, [], [], [], terminalFailures),
            processorPort(async () => {
                steps[0]!.status = BOOTSTRAP_STEP_STATUS.Paused;
                return terminalStepResult();
            }),
            wakePort([]),
            () => 1_000,
            logs.logger,
        );

        await orchestrator.run({
            runId: run.runId,
            traceId: TEST_TRACE_ID,
            laneName: TEST_LANE_NAME,
            laneStepKeys: [BOOTSTRAP_STEP_KEY.Ownership],
            leaseOwner: TEST_LEASE_OWNER,
            leaseMs: 1_000,
            maxProgressStaleMs: 30_000,
            claimLimit: 1,
            maxIterations: 1,
            retryPolicy: TEST_RETRY_POLICY,
        });

        expect(terminalFailures).toEqual([]);
        expect(steps[0]?.status).toBe(BOOTSTRAP_STEP_STATUS.Paused);
        expect(logs.entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    level: TEST_LOG_LEVEL.Debug,
                    meta: expect.objectContaining({
                        action:
                            BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION
                                .StepPausedObserved,
                        stepKey: BOOTSTRAP_STEP_KEY.Ownership,
                    }),
                }),
            ]),
        );
    });

    it("marks invalid ready outcomes as orchestration failures", async () => {
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
            processorPort(async () => readyStepResult(Number.NaN)),
            wakePort([]),
        );

        await orchestrator.run(
            orchestratorInput(run.runId, [BOOTSTRAP_STEP_KEY.Metadata]),
        );

        expect(terminalFailures).toEqual([
            expect.objectContaining({
                stepKey: BOOTSTRAP_STEP_KEY.Metadata,
                attempts: 1,
                error: expect.stringContaining(
                    BOOTSTRAP_STEP_ORCHESTRATION_ERROR.InvalidReadyOutcome,
                ),
            }),
        ]);
        expect(steps[0]?.status).toBe(BOOTSTRAP_STEP_STATUS.FailedTerminal);
    });

    it("renews the running step lease while the processor is active", async () => {
        const run = buildRun();
        const renewals: Array<{
            stepKey: BootstrapStepKey;
            leaseOwner: string;
            leaseUntil: number;
        }> = [];
        const orchestrator = new BootstrapStepOrchestrator(
            runsPort(run),
            stepsPort(
                [
                    step(
                        BOOTSTRAP_STEP_KEY.Enumeration,
                        BOOTSTRAP_STEP_STATUS.Ready,
                    ),
                ],
                [],
                [],
                [],
                [],
                renewals,
            ),
            processorPort(async () => {
                await sleep(20);
                return readyStepResult(3_000);
            }),
            wakePort([]),
            () => 1_000,
        );

        await orchestrator.run({
            runId: run.runId,
            traceId: TEST_TRACE_ID,
            laneName: TEST_LANE_NAME,
            laneStepKeys: [BOOTSTRAP_STEP_KEY.Enumeration],
            leaseOwner: TEST_LEASE_OWNER,
            leaseMs: 9,
            maxProgressStaleMs: 30_000,
            claimLimit: 1,
            maxIterations: 1,
            retryPolicy: TEST_RETRY_POLICY,
        });

        expect(renewals.length).toBeGreaterThan(0);
        expect(renewals).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    stepKey: BOOTSTRAP_STEP_KEY.Enumeration,
                    leaseOwner: TEST_LEASE_OWNER,
                    leaseUntil: 1_009,
                }),
            ]),
        );
    });

    it("keeps renewing while observed progress changes", async () => {
        const run = buildRun();
        const renewals: Array<{
            stepKey: BootstrapStepKey;
            leaseOwner: string;
            leaseUntil: number;
        }> = [];
        let progressVersion = 0;
        const logs = createLogCapture();
        const orchestrator = new BootstrapStepOrchestrator(
            runsPort(run),
            stepsPort(
                [
                    step(
                        BOOTSTRAP_STEP_KEY.Enumeration,
                        BOOTSTRAP_STEP_STATUS.Ready,
                    ),
                ],
                [],
                [],
                [],
                [],
                renewals,
            ),
            processorPort(async () => {
                await sleep(20);
                return readyStepResult(3_000);
            }),
            wakePort([]),
            Date.now,
            logs.logger,
            progressObserverPort(() => {
                progressVersion += 1;
                return {
                    fingerprint: String(progressVersion),
                    completed: progressVersion,
                    total: 100,
                };
            }),
        );

        await orchestrator.run({
            runId: run.runId,
            traceId: TEST_TRACE_ID,
            laneName: TEST_LANE_NAME,
            laneStepKeys: [BOOTSTRAP_STEP_KEY.Enumeration],
            leaseOwner: TEST_LEASE_OWNER,
            leaseMs: 5,
            maxProgressStaleMs: 5,
            claimLimit: 1,
            maxIterations: 1,
            retryPolicy: TEST_RETRY_POLICY,
        });

        expect(renewals.length).toBeGreaterThan(0);
        expect(logs.entries).not.toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    meta: expect.objectContaining({
                        action:
                            BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION
                                .LeaseRenewalProgressStale,
                    }),
                }),
            ]),
        );
    });

    it("stops renewing when observed progress is stale", async () => {
        const run = buildRun();
        const renewals: Array<{
            stepKey: BootstrapStepKey;
            leaseOwner: string;
            leaseUntil: number;
        }> = [];
        const logs = createLogCapture();
        const orchestrator = new BootstrapStepOrchestrator(
            runsPort(run),
            stepsPort(
                [
                    step(
                        BOOTSTRAP_STEP_KEY.Enumeration,
                        BOOTSTRAP_STEP_STATUS.Ready,
                    ),
                ],
                [],
                [],
                [],
                [],
                renewals,
            ),
            processorPort(async () => {
                await sleep(30);
                return readyStepResult(3_000);
            }),
            wakePort([]),
            Date.now,
            logs.logger,
            progressObserverPort(() => ({
                fingerprint: "static-progress",
                completed: 0,
                total: 100,
            })),
        );

        await orchestrator.run({
            runId: run.runId,
            traceId: TEST_TRACE_ID,
            laneName: TEST_LANE_NAME,
            laneStepKeys: [BOOTSTRAP_STEP_KEY.Enumeration],
            leaseOwner: TEST_LEASE_OWNER,
            leaseMs: 5,
            maxProgressStaleMs: 10,
            claimLimit: 1,
            maxIterations: 1,
            retryPolicy: TEST_RETRY_POLICY,
        });

        expect(renewals.length).toBeGreaterThan(0);
        expect(logs.entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    level: TEST_LOG_LEVEL.Warn,
                    meta: expect.objectContaining({
                        action:
                            BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION
                                .LeaseRenewalProgressStale,
                        stepKey: BOOTSTRAP_STEP_KEY.Enumeration,
                        leaseOwner: TEST_LEASE_OWNER,
                    }),
                }),
            ]),
        );
    });

    it("logs scheduler claim, release, retry, and delegation context", async () => {
        const readyRun = buildRun();
        const readyLogs = createLogCapture();
        const readyOrchestrator = new BootstrapStepOrchestrator(
            runsPort(readyRun),
            stepsPort(
                [
                    step(
                        BOOTSTRAP_STEP_KEY.Metadata,
                        BOOTSTRAP_STEP_STATUS.Ready,
                    ),
                ],
                [],
                [],
            ),
            processorPort(async () => readyStepResult(2_000)),
            wakePort([]),
            () => 1_000,
            readyLogs.logger,
        );

        await readyOrchestrator.run(
            orchestratorInput(readyRun.runId, [BOOTSTRAP_STEP_KEY.Metadata]),
        );

        expect(readyLogs.entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    level: TEST_LOG_LEVEL.Debug,
                    meta: expect.objectContaining({
                        action:
                            BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION.StepClaimed,
                        laneName: TEST_LANE_NAME,
                        runId: readyRun.runId,
                        chainId: readyRun.chainId,
                        collectionId: readyRun.collectionId,
                        stepKey: BOOTSTRAP_STEP_KEY.Metadata,
                        leaseOwner: TEST_LEASE_OWNER,
                        leaseUntil: 2_000,
                    }),
                }),
                expect.objectContaining({
                    level: TEST_LOG_LEVEL.Debug,
                    meta: expect.objectContaining({
                        action:
                            BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION
                                .StepReleasedReady,
                        nextAttemptAt: 2_000,
                    }),
                }),
            ]),
        );

        const delegatedRun = buildRun();
        const delegatedLogs = createLogCapture();
        const delegatedOrchestrator = new BootstrapStepOrchestrator(
            runsPort(delegatedRun),
            stepsPort(
                [
                    step(
                        BOOTSTRAP_STEP_KEY.ImageCache,
                        BOOTSTRAP_STEP_STATUS.Ready,
                    ),
                ],
                [],
                [],
            ),
            processorPort(async () => runningStepResult(5_000)),
            wakePort([]),
            () => 1_000,
            delegatedLogs.logger,
        );

        await delegatedOrchestrator.run(
            orchestratorInput(delegatedRun.runId, [
                BOOTSTRAP_STEP_KEY.ImageCache,
            ]),
        );

        expect(delegatedLogs.entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    level: TEST_LOG_LEVEL.Debug,
                    meta: expect.objectContaining({
                        action:
                            BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION.StepDelegated,
                        laneName: TEST_LANE_NAME,
                        stepKey: BOOTSTRAP_STEP_KEY.ImageCache,
                        healthCheckAt: 5_000,
                    }),
                }),
            ]),
        );

        const retryRun = buildRun();
        const retryLogs = createLogCapture();
        const retryOrchestrator = new BootstrapStepOrchestrator(
            runsPort(retryRun),
            stepsPort(
                [
                    step(
                        BOOTSTRAP_STEP_KEY.Metadata,
                        BOOTSTRAP_STEP_STATUS.Ready,
                    ),
                ],
                [],
                [],
            ),
            processorPort(async () => {
                throw new Error("metadata exploded");
            }),
            wakePort([]),
            () => 1_000,
            retryLogs.logger,
        );

        await retryOrchestrator.run(
            orchestratorInput(retryRun.runId, [BOOTSTRAP_STEP_KEY.Metadata]),
        );

        expect(retryLogs.entries).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    level: TEST_LOG_LEVEL.Warn,
                    meta: expect.objectContaining({
                        action:
                            BOOTSTRAP_STEP_ORCHESTRATOR_LOG_ACTION
                                .StepRetryScheduled,
                        laneName: TEST_LANE_NAME,
                        stepKey: BOOTSTRAP_STEP_KEY.Metadata,
                        attempts: 1,
                        errorCode:
                            BOOTSTRAP_STEP_ORCHESTRATION_ERROR
                                .ProcessorException,
                    }),
                }),
            ]),
        );
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
    renewals: Array<{
        stepKey: BootstrapStepKey;
        leaseOwner: string;
        leaseUntil: number;
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
        renewStepLease: ({ stepKey, leaseOwner, leaseUntil }) => {
            const target = steps.find((stepItem) => stepItem.stepKey === stepKey);
            if (target && target.leaseOwner === leaseOwner) {
                target.leaseUntil = leaseUntil;
            }
            renewals.push({ stepKey, leaseOwner, leaseUntil });
        },
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

function progressObserverPort(
    observeStepProgress: BootstrapStepProgressObserverPort["observeStepProgress"],
): BootstrapStepProgressObserverPort {
    return { observeStepProgress };
}

function orchestratorInput(
    runId: number,
    laneStepKeys: readonly BootstrapStepKey[],
) {
    return {
        runId,
        traceId: TEST_TRACE_ID,
        laneName: TEST_LANE_NAME,
        laneStepKeys,
        leaseOwner: TEST_LEASE_OWNER,
        leaseMs: 1_000,
        maxProgressStaleMs: 30_000,
        claimLimit: 1,
        maxIterations: 1,
        retryPolicy: TEST_RETRY_POLICY,
    };
}

type TestLogEntry = {
    level: (typeof TEST_LOG_LEVEL)[keyof typeof TEST_LOG_LEVEL];
    message: string;
    meta?: Record<string, unknown>;
};

function createLogCapture(): {
    entries: TestLogEntry[];
    logger: BootstrapStepOrchestratorLoggerPort;
} {
    const entries: TestLogEntry[] = [];
    return {
        entries,
        logger: {
            debug: (message, meta) => {
                entries.push({
                    level: TEST_LOG_LEVEL.Debug,
                    message,
                    meta,
                });
            },
            warn: (message, meta) => {
                entries.push({
                    level: TEST_LOG_LEVEL.Warn,
                    message,
                    meta,
                });
            },
            error: (message, meta) => {
                entries.push({
                    level: TEST_LOG_LEVEL.Error,
                    message,
                    meta,
                });
            },
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
        imageSourceField: TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
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
