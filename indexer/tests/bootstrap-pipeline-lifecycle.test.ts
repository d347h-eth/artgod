import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import {
    OPENSEA_INTEGRATION_MODE,
    type OpenSeaIntegrationStatus,
} from "@artgod/shared/config/opensea-integration";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { BootstrapAnchorExecutor } from "../src/application/bootstrap-anchor-executor.js";
import { BootstrapEnumerationExecutor } from "../src/application/bootstrap-enumeration-executor.js";
import {
    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME,
    BootstrapBackfillExecutor,
    parseBootstrapBackfillDelegatedRange,
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
import type { MetadataStatsRecomputePayload } from "../src/domain/domain-jobs.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { SqliteBootstrapRuns } from "../src/infra/bootstrap/sqlite-runs.js";
import { SqliteBootstrapSteps } from "../src/infra/bootstrap/sqlite-steps.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import type { Hex, RpcBlock } from "../src/ports/rpc.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const TEST_CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001";
const TEST_ANCHOR_HASH =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
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

    beforeAll(async () => {
        const dbPath = await createTempDbPath();
        setDbPath(dbPath);
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
    });

    beforeEach(() => {
        db.exec(
            [
                "DELETE FROM bootstrap_run_events;",
                "DELETE FROM bootstrap_run_steps;",
                "DELETE FROM bootstrap_metadata_snapshot_tasks;",
                "DELETE FROM bootstrap_image_cache_tasks;",
                "DELETE FROM bootstrap_ownership_snapshot_tasks;",
                "DELETE FROM nft_balance_snapshots;",
                "DELETE FROM bootstrap_runs;",
                "DELETE FROM collections;",
            ].join("\n"),
        );
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
        const storage = new SqliteStorage();
        const statsRecomputeRequests: Array<{
            payload: MetadataStatsRecomputePayload;
            traceId: string;
        }> = [];
        const anchorExecutor = new BootstrapAnchorExecutor(
            {
                getBlockNumber: async () => 110,
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
                getBlockNumber: async () => 100,
            },
            storage,
            collections,
            bootstrapRuns,
            bootstrapSteps,
            backfillQueuePort(statsRecomputeRequests),
        );
        const collectionLiveExecutor = new BootstrapCollectionLiveExecutor(
            collections,
            bootstrapRuns,
            bootstrapSteps,
            bootstrapStorage,
            backfillQueuePort(statsRecomputeRequests),
        );

        const run = bootstrapRuns.getRun(runId);
        if (!run) {
            throw new Error("Missing seeded bootstrap run");
        }
        const anchorResult = await anchorExecutor.anchor({
            run,
            reorgDepth: 10,
        });
        if (!anchorResult.anchor) {
            throw new Error("Expected anchor selection");
        }
        await enumerationExecutor.execute({
            run,
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

        const backfillResult = await backfillExecutor.scheduleAfterSnapshot({
            chainId: 1,
            runId,
            collectionId,
            address: TEST_CONTRACT_ADDRESS,
            anchorBlock: 100,
            backfillBatchSize: 10,
            openSeaIntegration: disabledOpenSeaIntegration(),
            traceId: "trace-1",
            sourceJobId: "job-1",
        });

        expect(backfillResult.outcome).toBe(
            BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.CompletedWithoutBackfill,
        );
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
        expect(bootstrapSteps.getStep(runId, BOOTSTRAP_STEP_KEY.Anchor)).toEqual(
            expect.objectContaining({ status: BOOTSTRAP_STEP_STATUS.Succeeded }),
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
        expect(bootstrapSteps.getStep(runId, BOOTSTRAP_STEP_KEY.Metadata)).toEqual(
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
        expect(bootstrapSteps.getStep(runId, BOOTSTRAP_STEP_KEY.Backfill)).toEqual(
            expect.objectContaining({ status: BOOTSTRAP_STEP_STATUS.Skipped }),
        );
        expect(
            bootstrapSteps.getStep(runId, BOOTSTRAP_STEP_KEY.CollectionLive),
        ).toEqual(
            expect.objectContaining({ status: BOOTSTRAP_STEP_STATUS.Succeeded }),
        );
        expect(bootstrapStorage.getMetadataTaskCounts(runId).total).toBe(0);
        expect(collections.getCollection(1, collectionId)).toEqual(
            expect.objectContaining({
                status: COLLECTION_STATUS.Live,
                bootstrapAnchorBlock: 100,
                bootstrapLastSyncedBlock: 100,
            }),
        );
        expect(statsRecomputeRequests).toEqual([
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
            BOOTSTRAP_RUN_EVENT_CODE.OpenSeaSkipped,
            BOOTSTRAP_RUN_EVENT_CODE.RunCompleted,
        ]);
    });

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
        const bootstrapSteps = new SqliteBootstrapSteps();
        const bootstrapStorage = new SqliteBootstrapStorage();
        const collections = new SqliteCollectionRegistry();
        const storage = new SqliteStorage();
        const statsRecomputeRequests: Array<{
            payload: MetadataStatsRecomputePayload;
            traceId: string;
        }> = [];
        const anchorExecutor = new BootstrapAnchorExecutor(
            {
                getBlockNumber: async () => 110,
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
                getBlockNumber: async () => 100,
            },
            storage,
            collections,
            bootstrapRuns,
            bootstrapSteps,
            backfillQueuePort(statsRecomputeRequests),
        );
        const collectionLiveExecutor = new BootstrapCollectionLiveExecutor(
            collections,
            bootstrapRuns,
            bootstrapSteps,
            bootstrapStorage,
            backfillQueuePort(statsRecomputeRequests),
        );
        const scheduler = new BootstrapStepScheduler(
            bootstrapRuns as BootstrapStepSchedulerRunsPort,
            bootstrapSteps as BootstrapStepSchedulerStepsPort,
            {
                processClaimedStep: async ({ run, step, traceId }) => {
                    if (step.stepKey === BOOTSTRAP_STEP_KEY.Anchor) {
                        await anchorExecutor.anchor({ run, reorgDepth: 10 });
                    } else if (step.stepKey === BOOTSTRAP_STEP_KEY.Enumeration) {
                        if (
                            run.anchorBlock === null ||
                            run.anchorBlockHash === null ||
                            run.anchorBlockTimestamp === null
                        ) {
                            throw new Error("Missing anchor for enumeration");
                        }
                        await enumerationExecutor.execute({
                            run,
                            anchor: {
                                anchorBlock: run.anchorBlock,
                                anchorHash: run.anchorBlockHash as Hex,
                                anchorTimestamp: run.anchorBlockTimestamp,
                            },
                            metadataBatchSize: 1,
                            traceId,
                        });
                    } else if (step.stepKey === BOOTSTRAP_STEP_KEY.Metadata) {
                        bootstrapStorage.markMetadataTaskSucceeded(run.runId, "1", 1);
                        bootstrapStorage.markMetadataTaskSucceeded(run.runId, "2", 1);
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
                            chainId: run.chainId,
                            runId: run.runId,
                            collectionId: run.collectionId,
                            address: run.requestAddress,
                            anchorBlock: run.anchorBlock,
                            backfillBatchSize: 10,
                            openSeaIntegration: disabledOpenSeaIntegration(),
                            traceId,
                            sourceJobId: "scheduler-job-1",
                        });
                    } else if (step.stepKey === BOOTSTRAP_STEP_KEY.CollectionLive) {
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
            expect.objectContaining({ status: BOOTSTRAP_STEP_STATUS.Succeeded }),
        );
        expect(collections.getCollection(1, collectionId)).toEqual(
            expect.objectContaining({
                status: COLLECTION_STATUS.Live,
                bootstrapAnchorBlock: 100,
                bootstrapLastSyncedBlock: 100,
            }),
        );
        expect(statsRecomputeRequests).toEqual([
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
        let syncedBlockCount = 0;
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
        const statsRecomputeRequests: Array<{
            payload: MetadataStatsRecomputePayload;
            traceId: string;
        }> = [];
        const backfillRanges: Array<{
            fromBlock: number;
            toBlock: number;
        }> = [];
        const anchorExecutor = new BootstrapAnchorExecutor(
            {
                getBlockNumber: async () => 110,
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
                getBlockNumber: async () => 105,
            },
            {
                countCollectionSyncedBlocksInRange: () => syncedBlockCount,
            },
            collections,
            bootstrapRuns,
            bootstrapSteps,
            backfillQueuePort(statsRecomputeRequests, backfillRanges),
        );
        const collectionLiveExecutor = new BootstrapCollectionLiveExecutor(
            collections,
            bootstrapRuns,
            bootstrapSteps,
            bootstrapStorage,
            backfillQueuePort(statsRecomputeRequests),
        );
        const scheduler = new BootstrapStepScheduler(
            bootstrapRuns as BootstrapStepSchedulerRunsPort,
            bootstrapSteps as BootstrapStepSchedulerStepsPort,
            {
                processClaimedStep: async ({ run, step, traceId }) => {
                    if (step.stepKey === BOOTSTRAP_STEP_KEY.Anchor) {
                        await anchorExecutor.anchor({ run, reorgDepth: 10 });
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
                        bootstrapStorage.markMetadataTaskSucceeded(run.runId, "1", 1);
                        bootstrapStorage.markMetadataTaskSucceeded(run.runId, "2", 1);
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
                        const delegatedRange = parseBootstrapBackfillDelegatedRange(
                            step.resultJson,
                        );
                        const result = delegatedRange
                            ? await backfillExecutor.checkProgress({
                                  chainId: run.chainId,
                                  runId: run.runId,
                                  collectionId: run.collectionId,
                                  address: run.requestAddress,
                                  fromBlock: delegatedRange.fromBlock,
                                  toBlock: delegatedRange.toBlock,
                                  traceId,
                                  sourceJobId: "scheduler-job-2",
                              })
                            : await backfillExecutor.scheduleAfterSnapshot({
                                  chainId: run.chainId,
                                  runId: run.runId,
                                  collectionId: run.collectionId,
                                  address: run.requestAddress,
                                  anchorBlock: run.anchorBlock,
                                  backfillBatchSize: 10,
                                  openSeaIntegration: disabledOpenSeaIntegration(),
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
        syncedBlockCount = 5;
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
                fromBlock: 101,
                toBlock: 105,
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
                bootstrapLastSyncedBlock: 105,
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
    const result = db.prepare(
        "INSERT INTO bootstrap_runs " +
            "(chain_id, collection_id, request_slug, request_address, request_standard, metadata_mode, enumeration_mode, request_image_cache_mode, status) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
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
    statsRecomputeRequests: Array<{
        payload: MetadataStatsRecomputePayload;
        traceId: string;
    }>,
    backfillRanges: Array<{
        fromBlock: number;
        toBlock: number;
    }> = [],
): BootstrapBackfillQueuePort {
    return {
        scheduleBackfillRange: async (request) => {
            backfillRanges.push({
                fromBlock: request.fromBlock,
                toBlock: request.toBlock,
            });
        },
        scheduleBackfillCheck: async () => {
        },
        scheduleOpenSeaBootstrap: async () => {
            throw new Error("OpenSea bootstrap should be skipped");
        },
        publishMetadataStatsRecompute: async (request) => {
            statsRecomputeRequests.push(request);
        },
    };
}

function disabledOpenSeaIntegration(): OpenSeaIntegrationStatus {
    return {
        enabled: false,
        mode: OPENSEA_INTEGRATION_MODE.Disabled,
        reason: "disabled in lifecycle test",
        missingKeys: [],
        requiredKeys: [],
    };
}

function buildBlock(blockNumber: number): RpcBlock {
    return {
        number: blockNumber,
        hash: TEST_ANCHOR_HASH,
        parentHash:
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        timestamp: 1726000000,
        transactions: [],
    };
}

function listRunEventCodes(runId: number): string[] {
    const rows = db
        .prepare(
            "SELECT event_code FROM bootstrap_run_events WHERE run_id = ? ORDER BY id ASC",
        )
        .all(runId) as Array<{ event_code: string }>;
    return rows.map((row) => row.event_code);
}
