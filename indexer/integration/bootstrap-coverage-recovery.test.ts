import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, zeroAddress } from "viem";
import { db, setDbPath } from "@artgod/shared/database";
import { MigrationRunner } from "@artgod/shared/migrations";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    serializeBootstrapStepDependencies,
} from "@artgod/shared/bootstrap/pipeline";
import { OPENSEA_INTEGRATION_MODE } from "@artgod/shared/config/opensea-integration";
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { ERC1155_ABI } from "../src/abi/index.js";
import {
    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME,
    BootstrapBackfillExecutor,
    buildBootstrapBackfillDelegatedStepResult,
} from "../src/application/bootstrap-backfill-executor.js";
import { BootstrapCollectionLiveExecutor } from "../src/application/bootstrap-collection-live-executor.js";
import { BootstrapStartupReconciler } from "../src/application/bootstrap-startup-reconciler.js";
import { BootstrapStepScheduler } from "../src/application/bootstrap-step-scheduler.js";
import {
    runningStepResult,
    terminalStepResult,
} from "../src/application/bootstrap-step-orchestrator.js";
import { createBackfillSyncHandler } from "../src/application/backfill-sync-handler.js";
import { BackfillExecutionGate } from "../src/application/backfill-execution.js";
import { runWorker } from "../src/application/worker-runner.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import type { JobEnvelope, QueuePublication } from "../src/domain/jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import type { BackfillSyncPayload } from "../src/domain/sync-jobs.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { SqliteBootstrapRuns } from "../src/infra/bootstrap/sqlite-runs.js";
import { SqliteBootstrapSteps } from "../src/infra/bootstrap/sqlite-steps.js";
import { publishBootstrapBackfillRange } from "../src/infra/bootstrap/backfill-range-publisher.js";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import {
    IsolatedNats,
    waitForFixture,
} from "../tests/helpers/isolated-nats.js";
import {
    insertCollection,
    selectBalanceOwners,
    selectTransferCount,
} from "../tests/helpers/ownership-fixture.js";
import {
    RecoveryRpc,
    reorgRecoveryServices,
} from "../tests/helpers/reorg-recovery-fixture.js";
import { loadReorgRecoveryTestConfig } from "../tests/helpers/reorg-recovery-test-config.js";
import { syncBlockFixture } from "../tests/helpers/chain-fixture.js";
import { loadTestEnv } from "../tests/helpers/test-env.js";

// Migration filenames and ABI event names are asserted at their storage/wire boundaries.
const RESET = "067_reset_collection_sale_coverage.sql";
const AUTOMATIC_SYNC_SCHEMA = new Set([
    "068_recent_gap_checks.sql",
    "069_newest_gap_priority.sql",
    "070_sync_work_allocation.sql",
    "071_order_validation_chain_revision.sql",
    "072_pending_canonical_checks.sql",
]);
const CONTRACT = "0x1111111111111111111111111111111111111111";
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONSUMER = "bootstrap-coverage-recovery";
const ANCHOR = 100;
const RANGE = { fromBlock: 101, toBlock: 104 };

describe("bootstrap catch-up recovery across a coverage-reset upgrade", () => {
    loadTestEnv();
    const { natsBinary } = loadReorgRecoveryTestConfig();
    let artifacts: string;
    let databasePath: string;
    let migrationsDir: string;
    let broker: IsolatedNats | undefined;
    let queue: NatsJetStreamQueue | undefined;
    let stop: (() => Promise<void>) | undefined;

    beforeEach(async () => {
        const parent = resolveProjectPath(
            "tmp/bootstrap-coverage-recovery-nats",
        );
        await mkdir(parent, { recursive: true });
        artifacts = await mkdtemp(path.join(parent, "run-"));
        databasePath = path.join(artifacts, "bootstrap.sqlite");
        migrationsDir = path.join(artifacts, "migrations");
        await mkdir(migrationsDir);
        const source = resolveProjectPath("database/migrations");
        for (const name of await readdir(source))
            // Isolate the historical reset while supplying the schema required
            // by today's production adapters before constructing those adapters.
            if (
                name.endsWith(".sql") &&
                (name < RESET || AUTOMATIC_SYNC_SCHEMA.has(name))
            )
                await copyFile(
                    path.join(source, name),
                    path.join(migrationsDir, name),
                );
        setDbPath(databasePath);
        await new MigrationRunner(migrationsDir).runMigrations();
        broker = await IsolatedNats.start(
            natsBinary,
            artifacts,
            path.join(artifacts, "jetstream"),
        );
        queue = await NatsJetStreamQueue.connect({
            natsUrl: broker.url,
            streamPrefix: "bootstrap_recovery_fixture",
        });
    });
    afterEach(async () => {
        await stop?.();
        stop = undefined;
        await queue?.close();
        queue = undefined;
        await broker?.stop();
        broker = undefined;
    });

    it.each([1, 2])(
        "finishes a retained bootstrap with %i ACKed initial batches without repeating ERC1155 deltas",
        async (ackedBatches) => {
            const collectionId = insertCollection({
                chainId: 1,
                slug: "bootstrap-reset",
                address: CONTRACT,
                anchorBlock: ANCHOR,
            });
            db.prepare(
                "UPDATE collections SET standard=?, status=? WHERE collection_id=?",
            ).run(
                COLLECTION_STANDARD.Erc1155,
                COLLECTION_STATUS.Bootstrapping,
                collectionId,
            );
            const runId = seedRun(collectionId);
            const rpc = fixtureRpc();
            let services = reorgRecoveryServices(rpc);
            let runs = new SqliteBootstrapRuns();
            let steps = new SqliteBootstrapSteps();
            const originalJobs: JobEnvelope<BackfillSyncPayload>[] = [];
            await publishBootstrapBackfillRange(
                {
                    publish: async (_target, job) => {
                        originalJobs.push(
                            job as JobEnvelope<BackfillSyncPayload>,
                        );
                    },
                },
                {
                    chainId: 1,
                    collectionId,
                    ...RANGE,
                    batchSize: 2,
                },
            );
            const delivered: JobEnvelope<BackfillSyncPayload>[] = [];
            const startAcquisition = async () => {
                const handler = createBackfillSyncHandler({
                    reorgDepth: 3,
                    chainId: 1,
                    workerCount: 1,
                    wethAddress: zeroAddress,
                    rpc,
                    storage: services.storage,
                    commit: services.commit,
                    collectionsPort: services.registry,
                    extensions: { getInstall: () => null },
                    bidderIndex: {
                        isActive: () => false,
                        shouldEmit: () => false,
                    },
                    gate: new BackfillExecutionGate(),
                });
                return runWorker<BackfillSyncPayload>(
                    queue!,
                    {
                        queue: QUEUE_NAMES.BackfillSync,
                        consumerName: CONSUMER,
                        maxInFlight: 1,
                    },
                    async (job) => {
                        await handler(job);
                        delivered.push(job);
                    },
                );
            };
            stop = await startAcquisition();
            const oldPublications: QueuePublication[] = [];
            for (const job of originalJobs.slice(0, ackedBatches))
                oldPublications.push(
                    await queue!.publish(QUEUE_NAMES.BackfillSync, job),
                );
            await waitForFixture(
                () => delivered.length === ackedBatches,
                "initial catch-up acquisitions",
            );
            await stop();
            stop = undefined;
            for (const publication of oldPublications)
                await waitForFixture(
                    async () =>
                        !(await queue!.isPublicationPending(
                            publication,
                            CONSUMER,
                        )),
                    "initial catch-up ACK",
                );
            // In the partial case the tail remains queued across the DB upgrade.
            for (const job of originalJobs.slice(ackedBatches))
                await queue!.publish(QUEUE_NAMES.BackfillSync, job);
            steps.updateStepProgress(runId, BOOTSTRAP_STEP_KEY.Backfill, {
                completed: ackedBatches * 2,
                total: 4,
            });
            const retainedRun = runs.getRun(runId);
            const retainedStep = steps.getStep(
                runId,
                BOOTSTRAP_STEP_KEY.Backfill,
            );
            expect(selectBalanceOwners(1, collectionId, "1")).toEqual([
                { owner: OWNER, amount: ackedBatches === 1 ? "3" : "5" },
            ]);

            setDbPath(databasePath);
            await copyFile(
                resolveProjectPath(`database/migrations/${RESET}`),
                path.join(migrationsDir, RESET),
            );
            await new MigrationRunner(migrationsDir).runMigrations();
            setDbPath(databasePath);
            services = reorgRecoveryServices(rpc);
            runs = new SqliteBootstrapRuns();
            steps = new SqliteBootstrapSteps();
            expect(runs.getRun(runId)).toEqual(retainedRun);
            expect(steps.getStep(runId, BOOTSTRAP_STEP_KEY.Backfill)).toEqual(
                retainedStep,
            );
            expect(
                services.storage.countCollectionSyncedBlocksInRange(
                    1,
                    collectionId,
                    RANGE.fromBlock,
                    RANGE.toBlock,
                ),
            ).toBe(0);
            expect(
                services.registry
                    .getCollection(1, collectionId)
                    ?.gapRepairWindow(200),
            ).toBeNull();
            // Prove that ACKed initial IDs are still suppressed by the real broker.
            for (let index = 0; index < ackedBatches; index++)
                expect(
                    await queue!.publish(
                        QUEUE_NAMES.BackfillSync,
                        originalJobs[index],
                    ),
                ).toEqual(oldPublications[index]);

            let now = Date.now();
            const recoveredJobs: JobEnvelope[] = [];
            const backfill = new BootstrapBackfillExecutor(
                { getBlockNumber: async () => 200 },
                services.storage,
                services.registry,
                runs,
                steps,
                {
                    scheduleBackfillRange: async (request) =>
                        publishBootstrapBackfillRange(
                            {
                                publish: async (target, job) => {
                                    recoveredJobs.push(job);
                                    return queue!.publish(target, job);
                                },
                            },
                            request,
                        ),
                    scheduleBackfillCheck: async () => {},
                    scheduleOpenSeaBootstrap: async () => {
                        throw new Error("Unexpected OpenSea bootstrap");
                    },
                },
                services.gaps,
                () => now,
            );
            const live = new BootstrapCollectionLiveExecutor(
                services.registry,
                runs,
                steps,
                new SqliteBootstrapStorage(),
                {
                    enqueueBootstrapFinalStats: async () => {},
                },
            );
            const scheduler = new BootstrapStepScheduler(
                runs,
                steps,
                {
                    processClaimedStep: async ({ run, step, traceId }) => {
                        if (step.stepKey === BOOTSTRAP_STEP_KEY.Backfill) {
                            const result = await backfill.executeStep({
                                chainId: 1,
                                runId,
                                collectionId,
                                address: CONTRACT,
                                anchorBlock: ANCHOR,
                                backfillBatchSize: 2,
                                traceId,
                                sourceJobId: "bootstrap-fixture-check",
                                openSeaIntegration: {
                                    enabled: false,
                                    mode: OPENSEA_INTEGRATION_MODE.Disabled,
                                    reason: "fixture",
                                    missingKeys: [],
                                    requiredKeys: [],
                                },
                            });
                            return result.outcome ===
                                BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete
                                ? runningStepResult(now + 5000)
                                : terminalStepResult();
                        }
                        await live.complete({
                            run,
                            step,
                            traceId,
                            sourceJobId: "bootstrap-fixture-live",
                        });
                        return terminalStepResult();
                    },
                },
                { wakeBootstrapStep: async () => {} },
                () => now,
            );
            const woke: string[] = [];
            await new BootstrapStartupReconciler(runs, steps, {
                wakeBootstrapStep: async ({ stepKey }) => {
                    woke.push(stepKey);
                },
            }).reconcile({
                chainId: 1,
                limit: 10,
                traceId: "bootstrap-fixture-restart",
            });
            expect(woke).toContain(BOOTSTRAP_STEP_KEY.Backfill);
            const tick = () =>
                scheduler.runOnce({
                    chainId: 1,
                    runId,
                    traceId: "bootstrap-fixture-check",
                    laneName: "main",
                    laneStepKeys: [
                        BOOTSTRAP_STEP_KEY.Backfill,
                        BOOTSTRAP_STEP_KEY.CollectionLive,
                    ],
                    leaseOwner: "bootstrap-fixture",
                    leaseMs: 5000,
                    maxProgressStaleMs: 60_000,
                    claimLimit: 1,
                    maxIterationsPerRun: 10,
                    runLimit: 10,
                    retryPolicy: {
                        maxAttempts: 3,
                        baseDelayMs: 10,
                        maxDelayMs: 100,
                    },
                });
            // Normal retained-step dispatch finds the old range, not HEAD=200.
            await tick();
            expect(recoveredJobs).toHaveLength(1);
            stop = await startAcquisition();
            for (let index = 0; index < 2; index++) {
                const recovery = recoveredJobs[
                    index
                ] as JobEnvelope<BackfillSyncPayload>;
                await waitForFixture(
                    () => delivered.some((job) => job.jobId === recovery.jobId),
                    "fresh recovery delivery inside original dedupe window",
                );
                now += 5000;
                await tick();
            }
            expect(
                recoveredJobs.map(
                    (job) => (job.payload as BackfillSyncPayload).fromBlock,
                ),
            ).toEqual([103, 101]);
            expect(
                recoveredJobs.every((job) =>
                    originalJobs.every((old) => old.jobId !== job.jobId),
                ),
            ).toBe(true);
            expect(
                steps.getStep(runId, BOOTSTRAP_STEP_KEY.Backfill)?.status,
            ).toBe(BOOTSTRAP_STEP_STATUS.Succeeded);
            expect(runs.getRun(runId)?.status).toBe(
                BOOTSTRAP_RUN_STATUS.Completed,
            );
            expect(services.registry.getCollection(1, collectionId)).toEqual(
                expect.objectContaining({
                    status: COLLECTION_STATUS.Live,
                    bootstrapAnchorBlock: ANCHOR,
                    bootstrapLastSyncedBlock: RANGE.toBlock,
                }),
            );
            expect(
                services.storage.countCollectionSyncedBlocksInRange(
                    1,
                    collectionId,
                    RANGE.fromBlock,
                    RANGE.toBlock,
                ),
            ).toBe(4);
            expect(selectBalanceOwners(1, collectionId, "1")).toEqual([
                { owner: OWNER, amount: "5" },
            ]);
            expect(selectTransferCount(1, collectionId, "1")).toBe(2);
            expect(db.raw.pragma("integrity_check")).toEqual([
                { integrity_check: "ok" },
            ]);
            expect(db.raw.pragma("foreign_key_check")).toEqual([]);
        },
    );
});

function seedRun(collectionId: number): number {
    const anchor = syncBlockFixture(ANCHOR);
    const runId = Number(
        db
            .prepare(
                "INSERT INTO bootstrap_runs(chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,request_image_cache_mode,status,anchor_block,anchor_block_hash,anchor_block_timestamp) VALUES(1,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
                collectionId,
                "bootstrap-reset",
                CONTRACT,
                COLLECTION_STANDARD.Erc1155,
                BOOTSTRAP_METADATA_MODE.BestEffort,
                BOOTSTRAP_ENUMERATION_MODE.Enumerable,
                IMAGE_CACHE_MODE.Off,
                BOOTSTRAP_RUN_STATUS.Backfill,
                ANCHOR,
                anchor.hash,
                anchor.timestamp,
            ).lastInsertRowid,
    );
    const insert = db.prepare(
        "INSERT INTO bootstrap_run_steps(run_id,step_key,status,blocking,depends_on_json,result_json,lease_until) VALUES(?,?,?,1,?,?,?)",
    );
    insert.run(
        runId,
        BOOTSTRAP_STEP_KEY.Backfill,
        BOOTSTRAP_STEP_STATUS.Running,
        serializeBootstrapStepDependencies([]),
        JSON.stringify(buildBootstrapBackfillDelegatedStepResult(RANGE)),
        0,
    );
    insert.run(
        runId,
        BOOTSTRAP_STEP_KEY.CollectionLive,
        BOOTSTRAP_STEP_STATUS.Pending,
        serializeBootstrapStepDependencies([BOOTSTRAP_STEP_KEY.Backfill]),
        null,
        null,
    );
    return runId;
}

function fixtureRpc() {
    const rpc = new RecoveryRpc();
    for (const [blockNumber, quantity] of [
        [101, 3n],
        [103, 2n],
    ] as const) {
        const block = syncBlockFixture(blockNumber);
        const log = {
            address: CONTRACT,
            blockNumber,
            blockHash: block.hash,
            transactionHash: block.hash,
            logIndex: 0,
            topics: encodeEventTopics({
                abi: ERC1155_ABI,
                eventName: "TransferSingle",
                args: { operator: OWNER, from: zeroAddress, to: OWNER },
            }),
            data: encodeAbiParameters(
                [{ type: "uint256" }, { type: "uint256" }],
                [1n, quantity],
            ),
        };
        rpc.logs.push(log);
        rpc.transactions.set(block.hash, {
            hash: block.hash,
            from: OWNER,
            to: CONTRACT,
            input: "0x",
        });
        rpc.receipts.set(block.hash, {
            transactionHash: block.hash,
            logs: [log],
        });
    }
    return rpc;
}
