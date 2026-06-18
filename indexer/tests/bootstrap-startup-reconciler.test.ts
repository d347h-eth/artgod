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
    BOOTSTRAP_STARTUP_RECONCILE_OUTCOME,
    BootstrapStartupReconciler,
    type BootstrapStartupRunsPort,
    type BootstrapStartupStepsPort,
    type BootstrapStartupWakePort,
} from "../src/application/bootstrap-startup-reconciler.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import type { BootstrapRunDefinition } from "../src/ports/bootstrap-runs.js";
import type { BootstrapStepRecord } from "../src/ports/bootstrap-steps.js";

describe("bootstrap startup reconciler", () => {
    it("marks dependency-ready steps and wakes executor work", async () => {
        const run = buildRun(31);
        const markedReady: Array<{ runId: number; stepKey: BootstrapStepKey }> =
            [];
        const wakes: Array<{ runId: number; stepKey: BootstrapStepKey }> = [];
        const reconciler = new BootstrapStartupReconciler(
            runsPort([run]),
            stepsPortForRun(
                run.runId,
                [
                    step(
                        run.runId,
                        BOOTSTRAP_STEP_KEY.Anchor,
                        BOOTSTRAP_STEP_STATUS.Succeeded,
                    ),
                    step(
                        run.runId,
                        BOOTSTRAP_STEP_KEY.Enumeration,
                        BOOTSTRAP_STEP_STATUS.Pending,
                        [BOOTSTRAP_STEP_KEY.Anchor],
                    ),
                ],
                markedReady,
            ),
            wakePort(wakes),
        );

        const result = await reconciler.reconcile({
            chainId: run.chainId,
            limit: 10,
            traceId: "startup-test",
        });

        expect(result.runs[0]).toEqual(
            expect.objectContaining({
                outcome: BOOTSTRAP_STARTUP_RECONCILE_OUTCOME.Woke,
                readyStepKeys: [BOOTSTRAP_STEP_KEY.Enumeration],
                wakeableStepKeys: [BOOTSTRAP_STEP_KEY.Enumeration],
                error: null,
            }),
        );
        expect(markedReady).toEqual([
            {
                runId: run.runId,
                stepKey: BOOTSTRAP_STEP_KEY.Enumeration,
            },
        ]);
        expect(wakes).toEqual([
            {
                runId: run.runId,
                stepKey: BOOTSTRAP_STEP_KEY.Enumeration,
            },
        ]);
    });

    it("reports runs without planned steps without waking work", async () => {
        const run = buildRun(32);
        const wakes: Array<{ runId: number; stepKey: BootstrapStepKey }> = [];
        const reconciler = new BootstrapStartupReconciler(
            runsPort([run]),
            stepsPortForRun(run.runId, [], []),
            wakePort(wakes),
        );

        const result = await reconciler.reconcile({
            chainId: run.chainId,
            limit: 10,
            traceId: "startup-test",
        });

        expect(result.runs[0]).toEqual(
            expect.objectContaining({
                outcome: BOOTSTRAP_STARTUP_RECONCILE_OUTCOME.NoSteps,
                readyStepKeys: [],
                wakeableStepKeys: [],
                error: null,
            }),
        );
        expect(wakes).toEqual([]);
    });

    it("keeps sweeping after a run-level wake failure", async () => {
        const failedRun = buildRun(33);
        const okRun = buildRun(34);
        const wakes: Array<{ runId: number; stepKey: BootstrapStepKey }> = [];
        const reconciler = new BootstrapStartupReconciler(
            runsPort([failedRun, okRun]),
            stepsPortByRun(
                new Map([
                    [
                        failedRun.runId,
                        [
                            step(
                                failedRun.runId,
                                BOOTSTRAP_STEP_KEY.Metadata,
                                BOOTSTRAP_STEP_STATUS.Ready,
                            ),
                        ],
                    ],
                    [
                        okRun.runId,
                        [
                            step(
                                okRun.runId,
                                BOOTSTRAP_STEP_KEY.ImageCache,
                                BOOTSTRAP_STEP_STATUS.Ready,
                            ),
                        ],
                    ],
                ]),
                [],
            ),
            {
                wakeBootstrapStep: async ({ run, stepKey }) => {
                    if (run.runId === failedRun.runId) {
                        throw new Error("wake failed");
                    }
                    wakes.push({ runId: run.runId, stepKey });
                },
            },
        );

        const result = await reconciler.reconcile({
            chainId: failedRun.chainId,
            limit: 10,
            traceId: "startup-test",
        });

        expect(result.runs.map((run) => run.outcome)).toEqual([
            BOOTSTRAP_STARTUP_RECONCILE_OUTCOME.Failed,
            BOOTSTRAP_STARTUP_RECONCILE_OUTCOME.Woke,
        ]);
        expect(result.runs[0]?.error).toBe("Error: wake failed");
        expect(wakes).toEqual([
            {
                runId: okRun.runId,
                stepKey: BOOTSTRAP_STEP_KEY.ImageCache,
            },
        ]);
    });
});

function runsPort(runs: BootstrapRunDefinition[]): BootstrapStartupRunsPort {
    return {
        listRunsForStartupSweep: () => runs,
    };
}

function stepsPortForRun(
    runId: number,
    steps: BootstrapStepRecord[],
    markedReady: Array<{ runId: number; stepKey: BootstrapStepKey }>,
): BootstrapStartupStepsPort {
    return stepsPortByRun(new Map([[runId, steps]]), markedReady);
}

function stepsPortByRun(
    stepsByRun: Map<number, BootstrapStepRecord[]>,
    markedReady: Array<{ runId: number; stepKey: BootstrapStepKey }>,
): BootstrapStartupStepsPort {
    return {
        listRunSteps: (runId) => stepsByRun.get(runId) ?? [],
        markStepReady: (runId, stepKey) => {
            markedReady.push({ runId, stepKey });
        },
    };
}

function wakePort(
    wakes: Array<{ runId: number; stepKey: BootstrapStepKey }>,
): BootstrapStartupWakePort {
    return {
        wakeBootstrapStep: async ({ run, stepKey }) => {
            wakes.push({ runId: run.runId, stepKey });
        },
    };
}

function step(
    runId: number,
    stepKey: BootstrapStepKey,
    status: BootstrapStepRecord["status"],
    dependsOn: BootstrapStepKey[] = [],
): BootstrapStepRecord {
    return {
        runId,
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

function buildRun(runId: number): BootstrapRunDefinition {
    return {
        runId,
        chainId: 1,
        collectionId: runId,
        requestSlug: `collection-${runId}`,
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
