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
import { IMAGE_CACHE_MODE } from "@artgod/shared/media/token-image-cache";
import { ERC1155_ABI } from "../src/abi/index.js";
import {
    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME,
    BootstrapBackfillExecutor,
    buildBootstrapBackfillDelegatedStepResult,
} from "../src/application/bootstrap-backfill-executor.js";
import { BootstrapCollectionLiveExecutor } from "../src/application/bootstrap-collection-live-executor.js";
import { createBackfillSyncHandler } from "../src/application/backfill-sync-handler.js";
import { runWorker } from "../src/application/worker-runner.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import type { BackfillSyncPayload } from "../src/domain/sync-jobs.js";
import type { RpcLog } from "../src/ports/rpc.js";
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
import { createAppliedSyncFixture } from "../tests/helpers/applied-sync-fixture.js";
import { loadTestEnv } from "../tests/helpers/test-env.js";

// Migration filenames and ABI event names are asserted at their storage/wire boundaries.
const RESET = "067_reset_collection_sale_coverage.sql";
const CONTRACT = "0x1111111111111111111111111111111111111111";
const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONSUMER = "bootstrap-coverage-recovery";
const ANCHOR = 100;
const RANGE = { fromBlock: 101, toBlock: 104 };
const BACKFILL_LEASE_OWNER = "bootstrap-recovery-backfill";

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
            if (name.endsWith(".sql") && name != RESET)
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
        "resumes after %i applied scoped ranges and an ACKed hint without repeating ERC1155 deltas",
        async (appliedRanges) => {
            const collectionId = insertCollection({
                chainId: 1,
                slug: "bootstrap-reset",
                address: CONTRACT,
                anchorBlock: ANCHOR,
            });
            db.prepare(
                "UPDATE collections SET standard=?,status=? WHERE collection_id=?",
            ).run(
                COLLECTION_STANDARD.Erc1155,
                COLLECTION_STATUS.Bootstrapping,
                collectionId,
            );
            const runId = seedRun(collectionId);
            const rpc = fixtureRpc();
            let services = reorgRecoveryServices(rpc);
            createAppliedSyncFixture({
                chainId: 1,
                anchor: syncBlockFixture(ANCHOR),
                collections: [],
            });
            // Backfill's existing run/step owns acceptance; the hint is only a wakeup.
            await services.executor.runDue();
            services.progress.recordHeadSample(
                services.progress.captureHeadSample(1),
                syncBlockFixture(RANGE.toBlock),
                Date.now(),
            );
            const originalJobs: JobEnvelope<BackfillSyncPayload>[] = [];
            await publishBootstrapBackfillRange(
                {
                    publish: async (_target, job) => {
                        originalJobs.push(
                            job as JobEnvelope<BackfillSyncPayload>,
                        );
                    },
                },
                { chainId: 1, collectionId, ...RANGE },
            );
            expect(originalJobs).toHaveLength(1);
            let delivered = 0;
            let wakes = 0;
            const handler = createBackfillSyncHandler({
                reorgDepth: 3,
                chainId: 1,
                workerCount: 1,
                wethAddress: zeroAddress,
                rpc,
                storage: services.storage,
                commit: services.commit,
                canonicalChecks: services.checks,
                collectionsPort: services.registry,
                extensions: { getInstall: () => null },
                wakeCurrentSync: () => {
                    wakes++;
                },
            });
            stop = await runWorker(
                queue!,
                {
                    queue: QUEUE_NAMES.BackfillSync,
                    consumerName: CONSUMER,
                    maxInFlight: 1,
                },
                async (job) => {
                    await handler(job);
                    delivered++;
                },
            );
            const publication = await queue!.publish(
                QUEUE_NAMES.BackfillSync,
                originalJobs[0]!,
            );
            await waitForFixture(
                async () =>
                    delivered === 1 &&
                    !(await queue!.isPublicationPending(publication, CONSUMER)),
                "bootstrap hint ACK independent of acquisition",
            );
            expect(wakes).toBe(1);
            expect(rpc.logReads).toBe(0);
            expect(
                services.progress.collectionProgress(1, collectionId)?.applied
                    .number,
            ).toBe(ANCHOR);
            await stop();
            stop = undefined;
            for (let pass = 0; pass < appliedRanges * 2; pass++)
                await services.executor.runDue();
            const appliedBefore = ANCHOR + appliedRanges * 2;
            expect(
                services.progress.collectionProgress(1, collectionId)?.applied
                    .number,
            ).toBe(appliedBefore);
            expect(selectBalanceOwners(1, collectionId, "1")).toEqual([
                { owner: OWNER, amount: appliedRanges === 1 ? "3" : "5" },
            ]);
            const retainedRun = new SqliteBootstrapRuns().getRun(runId);
            const retainedStep = new SqliteBootstrapSteps().getStep(
                runId,
                BOOTSTRAP_STEP_KEY.Backfill,
            );

            await queue!.close();
            await broker!.stop();
            setDbPath(databasePath);
            await copyFile(
                resolveProjectPath(`database/migrations/${RESET}`),
                path.join(migrationsDir, RESET),
            );
            await new MigrationRunner(migrationsDir).runMigrations();
            setDbPath(databasePath);
            services = reorgRecoveryServices(rpc);
            const runs = new SqliteBootstrapRuns();
            const steps = new SqliteBootstrapSteps();
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
                services.progress.collectionProgress(1, collectionId)?.applied
                    .number,
            ).toBe(appliedBefore);
            broker = await IsolatedNats.start(
                natsBinary,
                artifacts,
                path.join(artifacts, "jetstream"),
            );
            queue = await NatsJetStreamQueue.connect({
                natsUrl: broker.url,
                streamPrefix: "bootstrap_recovery_fixture",
            });
            expect(
                await queue.isPublicationPending(publication, CONSUMER),
            ).toBe(false);

            const backfill = new BootstrapBackfillExecutor(
                { getBlockNumber: async () => 200 },
                services.progress,
                runs,
                steps,
                {
                    scheduleBackfillRange: async () => {
                        throw new Error(
                            "Retained catchup must not republish broker ranges",
                        );
                    },
                    scheduleBackfillCheck: async () => {},
                },
            );
            // Restart resumes through the same step claim used by the scheduler.
            expect(
                steps.claimReadySteps({
                    runId,
                    stepKeys: [BOOTSTRAP_STEP_KEY.Backfill],
                    leaseOwner: BACKFILL_LEASE_OWNER,
                    nowMs: Date.now(),
                    leaseUntil: Date.now() + 60_000,
                    limit: 1,
                }),
            ).toHaveLength(1);
            const input = {
                leaseOwner: BACKFILL_LEASE_OWNER,
                chainId: 1,
                runId,
                collectionId,
                address: CONTRACT,
                anchorBlock: ANCHOR,
                anchorHash: syncBlockFixture(ANCHOR).hash,
                traceId: "bootstrap-restart",
                sourceJobId: "bootstrap-check",
            };
            const initial = await backfill.executeStep(input);
            expect(initial.outcome).toBe(
                appliedRanges === 1
                    ? BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete
                    : BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillCompleted,
            );
            // Retained applied progress owns the missing suffix even with no
            // runnable broker delivery and historical coverage reset to zero.
            for (
                let pass = 0;
                services.progress.collectionProgress(1, collectionId)!.applied
                    .number < RANGE.toBlock && pass < 10;
                pass++
            )
                await services.executor.runDue();
            if (
                initial.outcome ===
                BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete
            )
                expect((await backfill.executeStep(input)).outcome).toBe(
                    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillCompleted,
                );
            expect(
                steps.getStep(runId, BOOTSTRAP_STEP_KEY.Backfill)?.status,
            ).toBe(BOOTSTRAP_STEP_STATUS.Succeeded);
            const live = new BootstrapCollectionLiveExecutor(
                services.registry,
                runs,
                steps,
                new SqliteBootstrapStorage(),
                services.progress,
                rpc,
                3,
            );
            steps.markStepReady(runId, BOOTSTRAP_STEP_KEY.CollectionLive);
            steps.claimReadySteps({
                runId,
                stepKeys: [BOOTSTRAP_STEP_KEY.CollectionLive],
                leaseOwner: "bootstrap-recovery-live",
                nowMs: Date.now(),
                leaseUntil: Date.now() + 60_000,
                limit: 1,
            });
            await live.complete({
                run: runs.getRun(runId)!,
                step: steps.getStep(runId, BOOTSTRAP_STEP_KEY.CollectionLive)!,
                traceId: "bootstrap-restart",
                sourceJobId: "bootstrap-live",
            });
            expect(runs.getRun(runId)?.status).toBe(
                BOOTSTRAP_RUN_STATUS.Completed,
            );
            expect(
                services.registry.getCollection(1, collectionId),
            ).toMatchObject({
                status: COLLECTION_STATUS.Live,
                bootstrapAnchorBlock: ANCHOR,
                bootstrapLastSyncedBlock: RANGE.toBlock,
            });
            expect(
                services.storage.countCollectionSyncedBlocksInRange(
                    1,
                    collectionId,
                    RANGE.fromBlock,
                    RANGE.toBlock,
                ),
            ).toBe(RANGE.toBlock - appliedBefore);
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
        BOOTSTRAP_STEP_KEY.Ownership,
        BOOTSTRAP_STEP_STATUS.Succeeded,
        serializeBootstrapStepDependencies([]),
        null,
        null,
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
    const rpc = new RecoveryRpc(Number.MAX_SAFE_INTEGER, RANGE.toBlock);
    for (const [blockNumber, quantity] of [
        [101, 3n],
        [103, 2n],
    ] as const) {
        const block = syncBlockFixture(blockNumber);
        const log: RpcLog = {
            address: CONTRACT,
            blockNumber,
            blockHash: block.hash,
            transactionHash: block.hash,
            logIndex: 0,
            topics: encodeEventTopics({
                abi: ERC1155_ABI,
                eventName: "TransferSingle",
                args: { operator: OWNER, from: zeroAddress, to: OWNER },
            }) as RpcLog["topics"],
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
            blockNumber,
            blockHash: block.hash,
            logs: [log],
        });
    }
    return rpc;
}
