import { beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    serializeBootstrapStepDependencies,
    type BootstrapStepKey,
} from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { BootstrapAnchorExecutor } from "../src/application/bootstrap-anchor-executor.js";
import { BootstrapEnumerationExecutor } from "../src/application/bootstrap-enumeration-executor.js";
import {
    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME,
    BootstrapBackfillExecutor,
    type BootstrapBackfillQueuePort,
} from "../src/application/bootstrap-backfill-executor.js";
import { BootstrapCollectionLiveExecutor } from "../src/application/bootstrap-collection-live-executor.js";
import {
    BootstrapStepScheduler,
    type BootstrapStepSchedulerRunsPort,
    type BootstrapStepSchedulerStepsPort,
} from "../src/application/bootstrap-step-scheduler.js";
import {
    runningStepResult,
    terminalStepResult,
} from "../src/application/bootstrap-step-orchestrator.js";
import {
    CollectionTokenScope,
    COLLECTION_STANDARD,
} from "../src/domain/collections.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { SqliteBootstrapRuns } from "../src/infra/bootstrap/sqlite-runs.js";
import { SqliteBootstrapSteps } from "../src/infra/bootstrap/sqlite-steps.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteChainProgress } from "../src/infra/storage/sqlite-chain-progress.js";
import type { Hex, RpcBlock } from "../src/ports/rpc.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { createCoordinatorFixture } from "./helpers/coordinated-sync-fixture.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";

const TEST_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001";
const TEST_ANCHOR_HASH = syncBlockFixture(900).hash;
const TEST_MAIN_LANE_STEP_KEYS = [
    BOOTSTRAP_STEP_KEY.Anchor,
    BOOTSTRAP_STEP_KEY.Enumeration,
    BOOTSTRAP_STEP_KEY.Metadata,
    BOOTSTRAP_STEP_KEY.Ownership,
    BOOTSTRAP_STEP_KEY.Backfill,
    BOOTSTRAP_STEP_KEY.CollectionLive,
] as const;
const TEST_MAIN_LANE_NAME = "main";
const TEST_RETRY_POLICY = {
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 100,
};
const TEST_BACKFILL_CHECK_DELAY_MS = 5_000;

describe("bootstrap pipeline lifecycle", () => {
    loadTestEnv();

    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    it("drives anchor, enumeration seed, and no-post-anchor live completion through SQLite adapters", async () => {
        const collectionId = seedCollection();
        const runId = seedBootstrapRun(collectionId);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Anchor);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Enumeration, [
            BOOTSTRAP_STEP_KEY.Anchor,
        ]);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Metadata, [
            BOOTSTRAP_STEP_KEY.Enumeration,
        ]);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Ownership, [
            BOOTSTRAP_STEP_KEY.Metadata,
        ]);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Backfill, [
            BOOTSTRAP_STEP_KEY.Ownership,
        ]);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.CollectionLive, [
            BOOTSTRAP_STEP_KEY.Backfill,
        ]);

        const bootstrapRuns = new SqliteBootstrapRuns();
        const bootstrapSteps = new SqliteBootstrapSteps();
        const bootstrapStorage = new SqliteBootstrapStorage();
        const collections = new SqliteCollectionRegistry();
        const progress = new SqliteChainProgress();
        const anchorExecutor = new BootstrapAnchorExecutor(
            {
                getBlockNumber: async () => 910,
                getBlock: async (blockNumber) => buildBlock(blockNumber),
            },
            bootstrapRuns,
            bootstrapSteps,
            collections,
        );
        const enumerationExecutor = new BootstrapEnumerationExecutor(
            {
                resolveTokenIds: async ({ onProgress }) => {
                    onProgress({ resolved: 0, total: 2 });
                    onProgress({ resolved: 2, total: 2 });
                    return ["1", "2"];
                },
            },
            bootstrapStorage,
            bootstrapRuns,
            bootstrapSteps,
            1,
        );
        const backfillExecutor = new BootstrapBackfillExecutor(
            {
                getBlockNumber: async () => 900,
            },
            progress,
            bootstrapRuns,
            bootstrapSteps,
            backfillQueuePort(),
        );
        const collectionLiveExecutor = new BootstrapCollectionLiveExecutor(
            collections,
            bootstrapRuns,
            bootstrapSteps,
            bootstrapStorage,
            progress,
            {
                getBlockNumber: async () => 910,
                getBlock: async (number) => buildBlock(number),
            },
            10,
        );

        const run = bootstrapRuns.getRun(runId);
        if (!run) {
            throw new Error("Missing seeded bootstrap run");
        }
        bootstrapSteps.claimReadySteps({
            runId,
            stepKeys: [BOOTSTRAP_STEP_KEY.Anchor],
            leaseOwner: "anchor-test",
            nowMs: Date.now(),
            leaseUntil: Date.now() + 60_000,
            limit: 1,
        });
        const anchorResult = await anchorExecutor.anchor({
            run,
            reorgDepth: 10,
            leaseOwner: "anchor-test",
        });
        if (!anchorResult.anchor) {
            throw new Error("Expected anchor selection");
        }
        bootstrapSteps.markStepReady(runId, BOOTSTRAP_STEP_KEY.Enumeration);
        bootstrapSteps.claimReadySteps({
            runId,
            stepKeys: [BOOTSTRAP_STEP_KEY.Enumeration],
            leaseOwner: "enumeration-test",
            nowMs: Date.now(),
            leaseUntil: Date.now() + 60_000,
            limit: 1,
        });
        await enumerationExecutor.execute({
            run: bootstrapRuns.getRun(runId)!,
            leaseOwner: "enumeration-test",
            anchor: anchorResult.anchor,
            metadataBatchSize: 1,
            traceId: "trace-1",
        });

        expect(bootstrapStorage.getMetadataTaskCounts(runId)).toEqual({
            pending: 2,
            retry: 0,
            succeeded: 0,
            failedTerminal: 0,
            total: 2,
        });
        bootstrapStorage.markMetadataTaskSucceeded(runId, "1", 1);
        bootstrapStorage.markMetadataTaskSucceeded(runId, "2", 1);
        bootstrapSteps.markStepSucceeded(runId, BOOTSTRAP_STEP_KEY.Metadata, {
            completed: 2,
            total: 2,
        });
        bootstrapSteps.markStepSucceeded(runId, BOOTSTRAP_STEP_KEY.Ownership, {
            completed: 2,
            total: 2,
        });

        bootstrapSteps.markStepReady(runId, BOOTSTRAP_STEP_KEY.Backfill);
        bootstrapSteps.claimReadySteps({
            runId,
            stepKeys: [BOOTSTRAP_STEP_KEY.Backfill],
            leaseOwner: "backfill-test",
            nowMs: Date.now(),
            leaseUntil: Date.now() + 60_000,
            limit: 1,
        });
        const backfillResult = await backfillExecutor.scheduleAfterSnapshot({
            leaseOwner: "backfill-test",
            chainId: 1,
            runId,
            collectionId,
            address: TEST_CONTRACT_ADDRESS,
            anchorBlock: 900,
            anchorHash: TEST_ANCHOR_HASH,
            traceId: "trace-1",
            sourceJobId: "job-1",
        });

        expect(backfillResult.outcome).toBe(
            BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillQueued,
        );
        expect(progress.collectionProgress(1, collectionId)).toBeNull();
        await applyEmptyCatchup(collectionId, 900);
        await backfillExecutor.executeStep({
            leaseOwner: "backfill-test",
            chainId: 1,
            runId,
            collectionId,
            address: TEST_CONTRACT_ADDRESS,
            anchorBlock: 900,
            anchorHash: TEST_ANCHOR_HASH,
            traceId: "trace-1",
            sourceJobId: "job-1",
        });
        bootstrapSteps.markStepReady(runId, BOOTSTRAP_STEP_KEY.CollectionLive);
        bootstrapSteps.claimReadySteps({
            runId,
            stepKeys: [BOOTSTRAP_STEP_KEY.CollectionLive],
            leaseOwner: "live-test",
            nowMs: Date.now(),
            leaseUntil: Date.now() + 60_000,
            limit: 1,
        });
        const collectionLiveRun = bootstrapRuns.getRun(runId);
        const collectionLiveStep = bootstrapSteps.getStep(
            runId,
            BOOTSTRAP_STEP_KEY.CollectionLive,
        );
        if (!collectionLiveRun || !collectionLiveStep) {
            throw new Error("Missing collection-live run or step");
        }
        await collectionLiveExecutor.complete({
            run: collectionLiveRun,
            step: collectionLiveStep,
            traceId: "trace-1",
            sourceJobId: "job-1",
        });
        expect(bootstrapRuns.getRun(runId)?.status).toBe(
            BOOTSTRAP_RUN_STATUS.Completed,
        );
        expect(
            bootstrapSteps.getStep(runId, BOOTSTRAP_STEP_KEY.Anchor),
        ).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Succeeded,
            }),
        );
        expect(
            bootstrapSteps.getStep(runId, BOOTSTRAP_STEP_KEY.Enumeration),
        ).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Succeeded,
                progressCompleted: 2,
                progressTotal: 2,
            }),
        );
        expect(
            bootstrapSteps.getStep(runId, BOOTSTRAP_STEP_KEY.Metadata),
        ).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Succeeded,
                progressCompleted: 2,
                progressTotal: 2,
            }),
        );
        expect(
            bootstrapSteps.getStep(runId, BOOTSTRAP_STEP_KEY.Ownership),
        ).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Succeeded,
                progressCompleted: 2,
                progressTotal: 2,
            }),
        );
        expect(
            bootstrapSteps.getStep(runId, BOOTSTRAP_STEP_KEY.Backfill),
        ).toEqual(
            expect.objectContaining({ status: BOOTSTRAP_STEP_STATUS.Skipped }),
        );
        expect(
            bootstrapSteps.getStep(runId, BOOTSTRAP_STEP_KEY.CollectionLive),
        ).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Succeeded,
            }),
        );
        expect(bootstrapStorage.getMetadataTaskCounts(runId).total).toBe(0);
        expect(collections.getCollection(1, collectionId)).toEqual(
            expect.objectContaining({
                status: COLLECTION_STATUS.Live,
                bootstrapAnchorBlock: 900,
                bootstrapLastSyncedBlock: 900,
            }),
        );
        expect(statsRecomputeRequests()).toEqual([
            expect.objectContaining({
                payload: expect.objectContaining({
                    chainId: 1,
                    collectionId,
                }),
                traceId: "trace-1",
            }),
        ]);
        expect(listRunEventCodes(runId)).toEqual([
            BOOTSTRAP_RUN_EVENT_CODE.RunAnchorSelected,
            BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationStarted,
            BOOTSTRAP_RUN_EVENT_CODE.MetadataEnumerationCompleted,
            BOOTSTRAP_RUN_EVENT_CODE.MetadataTasksSeeded,
            BOOTSTRAP_RUN_EVENT_CODE.MetadataQueued,
            BOOTSTRAP_RUN_EVENT_CODE.BackfillQueued,
            BOOTSTRAP_RUN_EVENT_CODE.RunCompleted,
        ]);
    });

    it.each(["expired lease", "replaced lease", "writer failure"] as const)(
        "keeps anchor publication coherent after %s",
        async (failure) => {
            const collectionId = seedCollection();
            const runId = seedBootstrapRun(collectionId);
            seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Anchor);
            const runs = new SqliteBootstrapRuns();
            const steps = new SqliteBootstrapSteps();
            const collections = new SqliteCollectionRegistry();
            steps.claimReadySteps({
                runId,
                stepKeys: [BOOTSTRAP_STEP_KEY.Anchor],
                leaseOwner: "anchor-test",
                nowMs: Date.now(),
                leaseUntil: Date.now() + 60_000,
                limit: 1,
            });
            if (failure === "writer failure")
                db.exec(
                    "CREATE TRIGGER reject_collection_anchor BEFORE UPDATE OF bootstrap_anchor_block ON collections BEGIN SELECT RAISE(ABORT,'test anchor failure'); END",
                );
            const executor = new BootstrapAnchorExecutor(
                {
                    getBlockNumber: async () => 910,
                    getBlock: async (number) => {
                        if (failure === "expired lease")
                            db.prepare(
                                "UPDATE bootstrap_run_steps SET lease_until=0 WHERE run_id=? AND step_key=?",
                            ).run(runId, BOOTSTRAP_STEP_KEY.Anchor);
                        if (failure === "replaced lease")
                            db.prepare(
                                "UPDATE bootstrap_run_steps SET lease_owner='replacement' WHERE run_id=? AND step_key=?",
                            ).run(runId, BOOTSTRAP_STEP_KEY.Anchor);
                        return buildBlock(number);
                    },
                },
                runs,
                steps,
                collections,
            );
            await expect(
                executor.anchor({
                    run: runs.getRun(runId)!,
                    reorgDepth: 10,
                    leaseOwner: "anchor-test",
                }),
            ).rejects.toThrow(
                failure === "writer failure"
                    ? "test anchor failure"
                    : "lost its current claim",
            );
            expect(runs.getRun(runId)).toMatchObject({
                status: BOOTSTRAP_RUN_STATUS.Queued,
                anchorBlock: null,
            });
            expect(
                steps.getStep(runId, BOOTSTRAP_STEP_KEY.Anchor)?.status,
            ).toBe(BOOTSTRAP_STEP_STATUS.Running);
            expect(
                collections.getCollection(1, collectionId)
                    ?.bootstrapAnchorBlock,
            ).toBeNull();
            expect(listRunEventCodes(runId)).toEqual([]);
        },
    );

    it("drives the blocking lane through the step scheduler", async () => {
        const collectionId = seedCollection();
        const runId = seedBootstrapRun(collectionId);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Anchor);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Enumeration, [
            BOOTSTRAP_STEP_KEY.Anchor,
        ]);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Metadata, [
            BOOTSTRAP_STEP_KEY.Enumeration,
        ]);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Ownership, [
            BOOTSTRAP_STEP_KEY.Metadata,
        ]);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Backfill, [
            BOOTSTRAP_STEP_KEY.Ownership,
        ]);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.CollectionLive, [
            BOOTSTRAP_STEP_KEY.Backfill,
        ]);

        const bootstrapRuns = new SqliteBootstrapRuns();
        const bootstrapSteps = new SqliteBootstrapSteps(() => 1_000);
        const bootstrapStorage = new SqliteBootstrapStorage();
        const collections = new SqliteCollectionRegistry(() => 1_000);
        const progress = new SqliteChainProgress();
        const anchorExecutor = new BootstrapAnchorExecutor(
            {
                getBlockNumber: async () => 910,
                getBlock: async (blockNumber) => buildBlock(blockNumber),
            },
            bootstrapRuns,
            bootstrapSteps,
            collections,
        );
        const enumerationExecutor = new BootstrapEnumerationExecutor(
            {
                resolveTokenIds: async () => ["1", "2"],
            },
            bootstrapStorage,
            bootstrapRuns,
            bootstrapSteps,
            1,
        );
        const backfillExecutor = new BootstrapBackfillExecutor(
            {
                getBlockNumber: async () => 900,
            },
            progress,
            bootstrapRuns,
            bootstrapSteps,
            backfillQueuePort(),
        );
        const collectionLiveExecutor = new BootstrapCollectionLiveExecutor(
            collections,
            bootstrapRuns,
            bootstrapSteps,
            bootstrapStorage,
            progress,
            {
                getBlockNumber: async () => 910,
                getBlock: async (number) => buildBlock(number),
            },
            10,
        );
        const scheduler = new BootstrapStepScheduler(
            bootstrapRuns as BootstrapStepSchedulerRunsPort,
            bootstrapSteps as BootstrapStepSchedulerStepsPort,
            {
                processClaimedStep: async ({
                    run,
                    step,
                    traceId,
                    leaseOwner,
                }) => {
                    if (step.stepKey === BOOTSTRAP_STEP_KEY.Anchor) {
                        await anchorExecutor.anchor({
                            run,
                            reorgDepth: 10,
                            leaseOwner,
                        });
                    } else if (
                        step.stepKey === BOOTSTRAP_STEP_KEY.Enumeration
                    ) {
                        if (
                            run.anchorBlock === null ||
                            run.anchorBlockHash === null ||
                            run.anchorBlockTimestamp === null
                        ) {
                            throw new Error("Missing anchor for enumeration");
                        }
                        await enumerationExecutor.execute({
                            run,
                            leaseOwner,
                            anchor: {
                                anchorBlock: run.anchorBlock,
                                anchorHash: run.anchorBlockHash as Hex,
                                anchorTimestamp: run.anchorBlockTimestamp,
                            },
                            metadataBatchSize: 1,
                            traceId,
                        });
                    } else if (step.stepKey === BOOTSTRAP_STEP_KEY.Metadata) {
                        bootstrapStorage.markMetadataTaskSucceeded(
                            run.runId,
                            "1",
                            1,
                        );
                        bootstrapStorage.markMetadataTaskSucceeded(
                            run.runId,
                            "2",
                            1,
                        );
                        bootstrapSteps.markStepSucceeded(
                            run.runId,
                            BOOTSTRAP_STEP_KEY.Metadata,
                            { completed: 2, total: 2 },
                        );
                    } else if (step.stepKey === BOOTSTRAP_STEP_KEY.Ownership) {
                        bootstrapSteps.markStepSucceeded(
                            run.runId,
                            BOOTSTRAP_STEP_KEY.Ownership,
                            { completed: 2, total: 2 },
                        );
                    } else if (step.stepKey === BOOTSTRAP_STEP_KEY.Backfill) {
                        if (run.anchorBlock === null) {
                            throw new Error("Missing anchor for backfill");
                        }
                        await backfillExecutor.scheduleAfterSnapshot({
                            leaseOwner,
                            chainId: run.chainId,
                            runId: run.runId,
                            collectionId: run.collectionId,
                            address: run.requestAddress,
                            anchorBlock: run.anchorBlock,
                            anchorHash: run.anchorBlockHash!,
                            traceId,
                            sourceJobId: "scheduler-job-1",
                        });
                        expect(
                            progress.collectionProgress(1, collectionId),
                        ).toBeNull();
                        await applyEmptyCatchup(collectionId, 900, 1_000);
                        await backfillExecutor.executeStep({
                            leaseOwner,
                            chainId: run.chainId,
                            runId: run.runId,
                            collectionId: run.collectionId,
                            address: run.requestAddress,
                            anchorBlock: run.anchorBlock,
                            anchorHash: run.anchorBlockHash!,
                            traceId,
                            sourceJobId: "scheduler-job-1",
                        });
                    } else if (
                        step.stepKey === BOOTSTRAP_STEP_KEY.CollectionLive
                    ) {
                        await collectionLiveExecutor.complete({
                            run,
                            step,
                            traceId,
                            sourceJobId: "scheduler-job-1",
                        });
                    }
                    return terminalStepResult();
                },
            },
            {
                wakeBootstrapStep: async () => {},
            },
            () => 1_000,
        );

        const result = await scheduler.runOnce({
            chainId: 1,
            runId,
            traceId: "trace-scheduler",
            laneName: TEST_MAIN_LANE_NAME,
            laneStepKeys: TEST_MAIN_LANE_STEP_KEYS,
            leaseOwner: "scheduler-lifecycle-test",
            leaseMs: 1_000,
            maxProgressStaleMs: 30_000,
            claimLimit: 1,
            maxIterationsPerRun: 20,
            runLimit: 10,
            retryPolicy: TEST_RETRY_POLICY,
        });

        expect(result.claimedStepKeys).toEqual(TEST_MAIN_LANE_STEP_KEYS);
        expect(bootstrapRuns.getRun(runId)?.status).toBe(
            BOOTSTRAP_RUN_STATUS.Completed,
        );
        expect(
            bootstrapSteps.getStep(runId, BOOTSTRAP_STEP_KEY.CollectionLive),
        ).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Succeeded,
            }),
        );
        expect(collections.getCollection(1, collectionId)).toEqual(
            expect.objectContaining({
                status: COLLECTION_STATUS.Live,
                bootstrapAnchorBlock: 900,
                bootstrapLastSyncedBlock: 900,
            }),
        );
        expect(statsRecomputeRequests()).toEqual([
            expect.objectContaining({
                payload: expect.objectContaining({
                    chainId: 1,
                    collectionId,
                }),
                traceId: "trace-scheduler",
            }),
        ]);
    });

    it("recovers delegated backfill work after the health-check deadline", async () => {
        let nowMs = 1_000;
        const progress = new SqliteChainProgress();
        const collectionId = seedCollection();
        const runId = seedBootstrapRun(collectionId);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Anchor);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Enumeration, [
            BOOTSTRAP_STEP_KEY.Anchor,
        ]);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Metadata, [
            BOOTSTRAP_STEP_KEY.Enumeration,
        ]);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Ownership, [
            BOOTSTRAP_STEP_KEY.Metadata,
        ]);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.Backfill, [
            BOOTSTRAP_STEP_KEY.Ownership,
        ]);
        seedBootstrapStep(runId, BOOTSTRAP_STEP_KEY.CollectionLive, [
            BOOTSTRAP_STEP_KEY.Backfill,
        ]);

        const bootstrapRuns = new SqliteBootstrapRuns();
        const bootstrapSteps = new SqliteBootstrapSteps(() => nowMs);
        const bootstrapStorage = new SqliteBootstrapStorage();
        const collections = new SqliteCollectionRegistry(() => nowMs);
        const backfillRanges: Array<{
            fromBlock: number;
            toBlock: number;
        }> = [];
        const anchorExecutor = new BootstrapAnchorExecutor(
            {
                getBlockNumber: async () => 910,
                getBlock: async (blockNumber) => buildBlock(blockNumber),
            },
            bootstrapRuns,
            bootstrapSteps,
            collections,
        );
        const enumerationExecutor = new BootstrapEnumerationExecutor(
            {
                resolveTokenIds: async () => ["1", "2"],
            },
            bootstrapStorage,
            bootstrapRuns,
            bootstrapSteps,
            1,
        );
        const backfillExecutor = new BootstrapBackfillExecutor(
            {
                getBlockNumber: async () => 905,
            },
            progress,
            bootstrapRuns,
            bootstrapSteps,
            backfillQueuePort(backfillRanges),
        );
        const collectionLiveExecutor = new BootstrapCollectionLiveExecutor(
            collections,
            bootstrapRuns,
            bootstrapSteps,
            bootstrapStorage,
            progress,
            {
                getBlockNumber: async () => 910,
                getBlock: async (number) => buildBlock(number),
            },
            10,
        );
        const scheduler = new BootstrapStepScheduler(
            bootstrapRuns as BootstrapStepSchedulerRunsPort,
            bootstrapSteps as BootstrapStepSchedulerStepsPort,
            {
                processClaimedStep: async ({
                    run,
                    step,
                    traceId,
                    leaseOwner,
                }) => {
                    if (step.stepKey === BOOTSTRAP_STEP_KEY.Anchor) {
                        await anchorExecutor.anchor({
                            run,
                            reorgDepth: 10,
                            leaseOwner,
                        });
                        return terminalStepResult();
                    }
                    if (step.stepKey === BOOTSTRAP_STEP_KEY.Enumeration) {
                        if (
                            run.anchorBlock === null ||
                            run.anchorBlockHash === null ||
                            run.anchorBlockTimestamp === null
                        ) {
                            throw new Error("Missing anchor for enumeration");
                        }
                        await enumerationExecutor.execute({
                            run,
                            leaseOwner,
                            anchor: {
                                anchorBlock: run.anchorBlock,
                                anchorHash: run.anchorBlockHash as Hex,
                                anchorTimestamp: run.anchorBlockTimestamp,
                            },
                            metadataBatchSize: 1,
                            traceId,
                        });
                        return terminalStepResult();
                    }
                    if (step.stepKey === BOOTSTRAP_STEP_KEY.Metadata) {
                        bootstrapStorage.markMetadataTaskSucceeded(
                            run.runId,
                            "1",
                            1,
                        );
                        bootstrapStorage.markMetadataTaskSucceeded(
                            run.runId,
                            "2",
                            1,
                        );
                        bootstrapSteps.markStepSucceeded(
                            run.runId,
                            BOOTSTRAP_STEP_KEY.Metadata,
                            { completed: 2, total: 2 },
                        );
                        return terminalStepResult();
                    }
                    if (step.stepKey === BOOTSTRAP_STEP_KEY.Ownership) {
                        bootstrapSteps.markStepSucceeded(
                            run.runId,
                            BOOTSTRAP_STEP_KEY.Ownership,
                            { completed: 2, total: 2 },
                        );
                        return terminalStepResult();
                    }
                    if (step.stepKey === BOOTSTRAP_STEP_KEY.Backfill) {
                        if (run.anchorBlock === null) {
                            throw new Error("Missing anchor for backfill");
                        }
                        const result = await backfillExecutor.executeStep({
                            leaseOwner,
                            chainId: run.chainId,
                            runId: run.runId,
                            collectionId: run.collectionId,
                            address: run.requestAddress,
                            anchorBlock: run.anchorBlock,
                            anchorHash: run.anchorBlockHash!,
                            traceId,
                            sourceJobId: "scheduler-job-2",
                        });
                        return result.outcome ===
                            BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillQueued ||
                            result.outcome ===
                                BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete
                            ? runningStepResult(
                                  nowMs + TEST_BACKFILL_CHECK_DELAY_MS,
                              )
                            : terminalStepResult();
                    }
                    if (step.stepKey === BOOTSTRAP_STEP_KEY.CollectionLive) {
                        await collectionLiveExecutor.complete({
                            run,
                            step,
                            traceId,
                            sourceJobId: "scheduler-job-2",
                        });
                        return terminalStepResult();
                    }
                    return terminalStepResult();
                },
            },
            {
                wakeBootstrapStep: async () => {},
            },
            () => nowMs,
        );
        const input = {
            chainId: 1,
            runId,
            traceId: "trace-scheduler",
            laneName: TEST_MAIN_LANE_NAME,
            laneStepKeys: TEST_MAIN_LANE_STEP_KEYS,
            leaseOwner: "scheduler-lifecycle-test",
            leaseMs: 1_000,
            maxProgressStaleMs: 30_000,
            claimLimit: 1,
            maxIterationsPerRun: 20,
            runLimit: 10,
            retryPolicy: TEST_RETRY_POLICY,
        };

        const delegated = await scheduler.runOnce(input);
        const backfillStepAfterDelegation = bootstrapSteps.getStep(
            runId,
            BOOTSTRAP_STEP_KEY.Backfill,
        );
        expect(progress.collectionProgress(1, collectionId)).toBeNull();
        await applyEmptyCatchup(collectionId, 905, nowMs);
        nowMs += TEST_BACKFILL_CHECK_DELAY_MS;
        const completed = await scheduler.runOnce(input);

        expect(delegated.claimedStepKeys).toEqual([
            BOOTSTRAP_STEP_KEY.Anchor,
            BOOTSTRAP_STEP_KEY.Enumeration,
            BOOTSTRAP_STEP_KEY.Metadata,
            BOOTSTRAP_STEP_KEY.Ownership,
            BOOTSTRAP_STEP_KEY.Backfill,
        ]);
        expect(backfillStepAfterDelegation).toEqual(
            expect.objectContaining({
                status: BOOTSTRAP_STEP_STATUS.Running,
                leaseOwner: null,
                leaseUntil: 6_000,
            }),
        );
        expect(backfillRanges).toEqual([
            {
                fromBlock: 901,
                toBlock: 905,
            },
        ]);
        expect(completed.claimedStepKeys).toEqual([
            BOOTSTRAP_STEP_KEY.Backfill,
            BOOTSTRAP_STEP_KEY.CollectionLive,
        ]);
        expect(bootstrapRuns.getRun(runId)?.status).toBe(
            BOOTSTRAP_RUN_STATUS.Completed,
        );
        expect(collections.getCollection(1, collectionId)).toEqual(
            expect.objectContaining({
                status: COLLECTION_STATUS.Live,
                bootstrapLastSyncedBlock: 905,
            }),
        );
    });
});

function seedCollection(): number {
    const scope = CollectionTokenScope.allContractTokens().toPersistence();
    db.prepare(
        "INSERT INTO collections " +
            "(chain_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        1,
        "milady-by-remilia-corporation",
        TEST_CONTRACT_ADDRESS,
        COLLECTION_STANDARD.Erc721,
        COLLECTION_STATUS.Bootstrapping,
        scope.tokenScopeKind,
        scope.scopeStartTokenId,
        scope.scopeTotalSupply,
    );
    const row = db
        .prepare("SELECT collection_id FROM collections WHERE chain_id = ?")
        .get(1) as { collection_id: number } | undefined;
    if (!row) {
        throw new Error("Missing seeded collection");
    }
    return row.collection_id;
}

function seedBootstrapRun(collectionId: number): number {
    const result = db
        .prepare(
            "INSERT INTO bootstrap_runs " +
                "(chain_id, collection_id, request_slug, request_address, request_standard, metadata_mode, enumeration_mode, request_image_cache_mode, status) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
            1,
            collectionId,
            "milady-by-remilia-corporation",
            TEST_CONTRACT_ADDRESS,
            COLLECTION_STANDARD.Erc721,
            BOOTSTRAP_METADATA_MODE.BestEffort,
            BOOTSTRAP_ENUMERATION_MODE.Enumerable,
            IMAGE_CACHE_MODE.Off,
            BOOTSTRAP_RUN_STATUS.Queued,
        );
    return Number(result.lastInsertRowid);
}

function seedBootstrapStep(
    runId: number,
    stepKey: BootstrapStepKey,
    dependsOn: BootstrapStepKey[] = [],
): void {
    db.prepare(
        "INSERT INTO bootstrap_run_steps " +
            "(run_id, step_key, status, blocking, depends_on_json) " +
            "VALUES (?, ?, ?, ?, ?)",
    ).run(
        runId,
        stepKey,
        stepKey === BOOTSTRAP_STEP_KEY.Anchor
            ? BOOTSTRAP_STEP_STATUS.Ready
            : BOOTSTRAP_STEP_STATUS.Pending,
        1,
        serializeBootstrapStepDependencies(dependsOn),
    );
}

function backfillQueuePort(
    backfillRanges: Array<{ fromBlock: number; toBlock: number }> = [],
): BootstrapBackfillQueuePort {
    return {
        scheduleBackfillRange: async (request) => {
            backfillRanges.push({
                fromBlock: request.fromBlock,
                toBlock: request.toBlock,
            });
        },
        scheduleBackfillCheck: async () => {},
    };
}

function statsRecomputeRequests() {
    return (
        db
            .prepare(
                "SELECT stats_job_json FROM metadata_refresh_runs ORDER BY run_id",
            )
            .all() as { stats_job_json: string }[]
    ).map((row) => JSON.parse(row.stats_job_json));
}

function buildBlock(blockNumber: number): RpcBlock {
    return syncBlockFixture(blockNumber);
}

function listRunEventCodes(runId: number): string[] {
    const rows = db
        .prepare(
            "SELECT event_code FROM bootstrap_run_events WHERE run_id = ? ORDER BY id ASC",
        )
        .all(runId) as Array<{ event_code: string }>;
    return rows.map((row) => row.event_code);
}

/** The real coordinator consumes Backfill's persisted authorization. No test
 * installs a collection base or advances its applied cursor directly. */
async function applyEmptyCatchup(
    collectionId: number,
    targetBlock: number,
    now = Date.now(),
) {
    const coordinator = createCoordinatorFixture({
        collectionCount: 0,
        now: () => now,
    });
    coordinator.remote.state.head = targetBlock;
    coordinator.sample(targetBlock);
    for (let pass = 0; pass < 30; pass++) {
        if (!(await coordinator.executor.runDue())) break;
        if (pass === 29)
            throw new Error("Coordinator did not finish delegated Backfill");
    }
    expect(
        coordinator.progress.collectionProgress(1, collectionId)?.applied
            .number,
    ).toBe(targetBlock);
}
