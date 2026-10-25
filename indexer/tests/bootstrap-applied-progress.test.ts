import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import {
    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME,
    BootstrapBackfillExecutor,
    parseBootstrapBackfillLiveBlock,
} from "../src/application/bootstrap-backfill-executor.js";
import { bootstrapAppliedCheckpoint } from "../src/application/bootstrap-applied-progress.js";
import type { BootstrapCollectionLiveCommit } from "../src/application/bootstrap-collection-live-executor.js";
import { SYNC_APPLICATION_KIND } from "../src/domain/sync-work.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { SqliteBootstrapRuns } from "../src/infra/bootstrap/sqlite-runs.js";
import { SqliteBootstrapSteps } from "../src/infra/bootstrap/sqlite-steps.js";
import { advanceChainSyncRevision } from "../src/infra/storage/sqlite-chain-revisions.js";
import { createCoordinatorFixture } from "./helpers/coordinated-sync-fixture.js";
import { prepareBootstrapSnapshotFixture } from "./helpers/bootstrap-snapshot-fixture.js";
import { insertCollection } from "./helpers/ownership-fixture.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const CHAIN_ID = 1;
const ANCHOR = 900;
const ADDRESS = "0x0000000000000000000000000000000000000001";
const LEASE_OWNER = "bootstrap-applied-live";

describe("bootstrap completion uses applied progress", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    async function fixture(
        target = ANCHOR + 5,
        interruptAt?: "range" | "terminal",
    ) {
        const collectionId = insertCollection({
            chainId: CHAIN_ID,
            slug: "bootstrap-applied",
            address: ADDRESS,
            anchorBlock: ANCHOR,
        });
        const runId = 1;
        prepareBootstrapSnapshotFixture({
            runId,
            chainId: CHAIN_ID,
            collectionId,
            contract: ADDRESS,
            anchorBlock: ANCHOR,
            anchorHash: block(ANCHOR).hash,
            anchorTimestamp: block(ANCHOR).timestamp,
        });
        const now = Date.now();
        const runs = new SqliteBootstrapRuns();
        const steps = new SqliteBootstrapSteps(() => now);
        steps.markStepSucceeded(runId, BOOTSTRAP_STEP_KEY.Ownership);
        for (const step of [
            BOOTSTRAP_STEP_KEY.Backfill,
            BOOTSTRAP_STEP_KEY.CollectionLive,
        ])
            db.prepare(
                "INSERT INTO bootstrap_run_steps(run_id,step_key,status) VALUES (?,?,?)",
            ).run(runId, step, BOOTSTRAP_STEP_STATUS.Pending);
        const work = createCoordinatorFixture({
            collectionCount: 0,
            now: () => now,
        });
        const input = {
            chainId: CHAIN_ID,
            collectionId,
            runId,
            address: ADDRESS,
            anchorBlock: ANCHOR,
            anchorHash: block(ANCHOR).hash,
            traceId: "bootstrap-applied",
            sourceJobId: "bootstrap-check",
        };
        let interruptPending = interruptAt === "range";
        let interruptTerminal = interruptAt === "terminal";
        const check = new BootstrapBackfillExecutor(
            { getBlockNumber: async () => target },
            work.progress,
            runs,
            {
                getStep: steps.getStep.bind(steps),
                markStepRunning: steps.markStepRunning.bind(steps),
                markStepSucceeded: (...args) => {
                    steps.markStepSucceeded(...args);
                    if (interruptTerminal) {
                        interruptTerminal = false;
                        throw new Error(
                            "Lost worker after terminal Backfill write",
                        );
                    }
                },
                markStepSkipped: (...args) => {
                    steps.markStepSkipped(...args);
                    if (interruptTerminal) {
                        interruptTerminal = false;
                        throw new Error(
                            "Lost worker after terminal Backfill write",
                        );
                    }
                },
                updateStepProgress: steps.updateStepProgress.bind(steps),
                updateStepResult: (...args) => {
                    steps.updateStepResult(...args);
                    if (interruptPending) {
                        interruptPending = false;
                        throw new Error(
                            "Lost worker after retaining Backfill range",
                        );
                    }
                },
            },
            {
                scheduleBackfillRange: async () => {},
                scheduleBackfillCheck: async () => {},
            },
        );
        // Completed ownership alone cannot admit this collection.
        await work.executor.runDue();
        expect(
            work.progress.collectionProgress(CHAIN_ID, collectionId),
        ).toBeNull();
        if (interruptAt === "range")
            await expect(check.scheduleAfterSnapshot(input)).rejects.toThrow(
                "Lost worker after retaining Backfill range",
            );
        else {
            const scheduled = await check.scheduleAfterSnapshot(input);
            expect(scheduled.outcome).toBe(
                BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillQueued,
            );
        }
        const apply = async () => {
            work.remote.state.head = target;
            work.sample(target);
            for (let pass = 0; pass < 30; pass++) {
                if (!(await work.executor.runDue())) return;
            }
            throw new Error("Coordinator did not finish delegated range");
        };
        const finishInput =
            async (): Promise<BootstrapCollectionLiveCommit> => {
                await check.executeStep(input);
                steps.markStepReady(runId, BOOTSTRAP_STEP_KEY.CollectionLive);
                steps.claimReadySteps({
                    runId,
                    stepKeys: [BOOTSTRAP_STEP_KEY.CollectionLive],
                    leaseOwner: LEASE_OWNER,
                    nowMs: now,
                    leaseUntil: now + 60_000,
                    limit: 1,
                });
                return {
                    chainId: CHAIN_ID,
                    collectionId,
                    runId,
                    leaseOwner: LEASE_OWNER,
                    lastSyncedBlock: target,
                    checkpoint: bootstrapAppliedCheckpoint(
                        work.progress,
                        input,
                    )!,
                    anchor: block(ANCHOR),
                    headBlock: ANCHOR + 32,
                    reorgDepth: 32,
                    finalStats: null,
                };
            };
        return {
            ...work,
            check,
            input,
            collectionId,
            runId,
            runs,
            steps,
            apply,
            finishInput,
            blocks: Array.from({ length: target - ANCHOR }, (_, i) =>
                block(ANCHOR + i + 1),
            ),
        };
    }

    it("does not complete from full raw coverage; completes once collection effects reach the retained target", async () => {
        const f = await fixture();
        // Shared effects and raw collection history do not stand in for scoped application.
        f.commitFixture(
            f.applied({ blocks: f.blocks, shared: true, collectionIds: [] }),
        );
        f.commitFixture({
            ...f.applied({
                blocks: f.blocks,
                shared: false,
                collectionIds: [],
            }),
            application: { kind: SYNC_APPLICATION_KIND.Historical },
            collections: [f.registry.getCollection(CHAIN_ID, f.collectionId)!],
        });
        expect(
            f.storage.countCollectionSyncedBlocksInRange(
                CHAIN_ID,
                f.collectionId,
                901,
                905,
            ),
        ).toBe(5);
        expect(await f.check.executeStep(f.input)).toMatchObject({
            outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete,
            synced: 0,
        });
        await f.apply();
        expect(await f.check.executeStep(f.input)).toMatchObject({
            outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillCompleted,
            synced: 5,
        });
    });

    it("requires explicit Backfill delegation and coordinator acceptance even without post-anchor work", async () => {
        const f = await fixture(ANCHOR);
        expect(await f.check.executeStep(f.input)).toMatchObject({
            outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete,
        });
        expect(
            f.progress.collectionProgress(CHAIN_ID, f.collectionId),
        ).toBeNull();
        await f.apply();
        expect(await f.check.executeStep(f.input)).toMatchObject({
            outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillCompleted,
            synced: 0,
        });
        expect(
            f.steps.getStep(f.runId, BOOTSTRAP_STEP_KEY.Backfill)?.status,
        ).toBe(BOOTSTRAP_STEP_STATUS.Skipped);
    });

    it("resumes if the worker stops immediately after retaining the delegated range", async () => {
        const f = await fixture(ANCHOR + 5, "range");
        expect(f.runs.getRun(f.runId)?.status).toBe(
            BOOTSTRAP_RUN_STATUS.Backfill,
        );
        expect(await f.check.executeStep(f.input)).toMatchObject({
            outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillIncomplete,
        });
        await f.apply();
        expect(await f.check.executeStep(f.input)).toMatchObject({
            outcome: BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.BackfillCompleted,
        });
    });

    it.each([ANCHOR, ANCHOR + 5])(
        "retains the Live handoff if the worker stops immediately after terminalizing Backfill at %i",
        async (target) => {
            const f = await fixture(target, "terminal");
            await f.apply();
            await expect(f.check.executeStep(f.input)).rejects.toThrow(
                "Lost worker after terminal Backfill write",
            );
            const retained = f.steps.getStep(
                f.runId,
                BOOTSTRAP_STEP_KEY.Backfill,
            )!;
            expect(retained.status).toBe(
                target === ANCHOR
                    ? BOOTSTRAP_STEP_STATUS.Skipped
                    : BOOTSTRAP_STEP_STATUS.Succeeded,
            );
            expect(parseBootstrapBackfillLiveBlock(retained.resultJson)).toBe(
                target,
            );
            expect(
                f.registry.markBootstrapFinished(await f.finishInput()),
            ).toBe(true);
        },
    );

    it.each(["revision", "dispute"] as const)(
        "fences final liveness inside the writer after a concurrent %s change",
        async (change) => {
            const f = await fixture();
            await f.apply();
            const commit = await f.finishInput();
            if (change === "revision") advanceChainSyncRevision(CHAIN_ID);
            else
                f.progress.retainDispute({
                    checkpoint: commit.checkpoint,
                    chainId: CHAIN_ID,
                    blockNumber: commit.checkpoint.block.number,
                    blockHash: commit.checkpoint.block.hash,
                });
            expect(() => f.registry.markBootstrapFinished(commit)).toThrow(
                ChainSyncConflict,
            );
            expect(
                f.registry.getCollection(CHAIN_ID, f.collectionId)?.status,
            ).toBe(COLLECTION_STATUS.Bootstrapping);
        },
    );

    it("makes collection, core step and run complete only after coordinated application", async () => {
        const f = await fixture();
        await f.apply();
        expect(f.registry.markBootstrapFinished(await f.finishInput())).toBe(
            true,
        );
        expect(f.registry.getCollection(CHAIN_ID, f.collectionId)?.status).toBe(
            COLLECTION_STATUS.Live,
        );
        expect(f.runs.getRun(f.runId)?.status).toBe(
            BOOTSTRAP_RUN_STATUS.Completed,
        );
        expect(
            f.steps.getStep(f.runId, BOOTSTRAP_STEP_KEY.CollectionLive)?.status,
        ).toBe(BOOTSTRAP_STEP_STATUS.Succeeded);
    });
});
