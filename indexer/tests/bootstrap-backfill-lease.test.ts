import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { SqliteBootstrapRuns } from "../src/infra/bootstrap/sqlite-runs.js";
import { SqliteBootstrapSteps } from "../src/infra/bootstrap/sqlite-steps.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import {
    BootstrapBackfillExecutor,
    BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME,
    parseBootstrapBackfillLiveBlock,
} from "../src/application/bootstrap-backfill-executor.js";
import {
    BootstrapStepOrchestrator,
    terminalStepResult,
    runningStepResult,
} from "../src/application/bootstrap-step-orchestrator.js";
import { BootstrapCollectionLiveExecutor } from "../src/application/bootstrap-collection-live-executor.js";
import { bootstrapCatchupAuthority } from "../src/infra/bootstrap/sqlite-catchup-authority.js";
import {
    createCoordinatorFixture,
    installedCoordinatorCollection,
    authorizeCoordinatorBootstrapCatchup,
} from "./helpers/coordinated-sync-fixture.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const ANCHOR = 900;
const TARGET = 904;
const LEASE_MS = 60_000;
const OLD_OWNER = "old-backfill";
const CURRENT_OWNER = "current-backfill";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

describe("Backfill claim fencing through real persistence and coordinator", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    function fixture() {
        let now = Date.now();
        const coordinator = createCoordinatorFixture({
            batchSize: 10,
            now: () => now,
        });
        const collection = installedCoordinatorCollection(
            "backfill-claim",
            ANCHOR,
        );
        const runId = authorizeCoordinatorBootstrapCatchup(
            collection.id,
            ANCHOR,
            TARGET,
        );
        db.prepare("UPDATE bootstrap_runs SET status=? WHERE run_id=?").run(
            BOOTSTRAP_RUN_STATUS.Ownership,
            runId,
        );
        db.prepare(
            "UPDATE bootstrap_run_steps SET result_json=NULL,status=?,lease_owner=NULL,lease_until=NULL WHERE run_id=? AND step_key=?",
        ).run(BOOTSTRAP_STEP_STATUS.Ready, runId, BOOTSTRAP_STEP_KEY.Backfill);
        const runs = new SqliteBootstrapRuns();
        const steps = new SqliteBootstrapSteps(() => now);
        const queue = {
            scheduleBackfillRange: async () => {},
            scheduleBackfillCheck: async () => {},
        };
        const input = {
            runId,
            chainId: 1,
            collectionId: collection.id,
            anchorBlock: ANCHOR,
            anchorHash: block(ANCHOR).hash,
            address: collection.address,
            traceId: "backfill-claim",
            sourceJobId: "backfill-claim",
        };
        const executor = (getBlockNumber: () => Promise<number>) =>
            new BootstrapBackfillExecutor(
                { getBlockNumber },
                coordinator.progress,
                runs,
                steps,
                queue,
            );
        const claim = (leaseOwner: string) => {
            const claimed = steps.claimReadySteps({
                runId,
                stepKeys: [BOOTSTRAP_STEP_KEY.Backfill],
                leaseOwner,
                nowMs: now,
                leaseUntil: now + LEASE_MS,
                limit: 1,
            });
            expect(claimed).toHaveLength(1);
        };
        const finish = async () => {
            coordinator.sample(TARGET);
            for (
                let i = 0;
                i < 20 &&
                coordinator.progress.collectionProgress(1, collection.id)
                    ?.applied.number !== TARGET;
                i++
            )
                await coordinator.executor.runDue();
            expect(
                coordinator.progress.collectionProgress(1, collection.id)
                    ?.applied.number,
            ).toBe(TARGET);
            await executor(async () => TARGET).executeStep({
                ...input,
                leaseOwner: CURRENT_OWNER,
            });
            expect(
                parseBootstrapBackfillLiveBlock(
                    steps.getStep(runId, BOOTSTRAP_STEP_KEY.Backfill)!
                        .resultJson,
                ),
            ).toBe(TARGET);
        };
        const goLive = async () => {
            db.prepare(
                "INSERT INTO bootstrap_run_steps(run_id,step_key,status) VALUES (?,?,?)",
            ).run(
                runId,
                BOOTSTRAP_STEP_KEY.CollectionLive,
                BOOTSTRAP_STEP_STATUS.Ready,
            );
            const live = new BootstrapCollectionLiveExecutor(
                coordinator.registry,
                runs,
                steps,
                new SqliteBootstrapStorage(),
                coordinator.progress,
                {
                    getBlockNumber: async () => ANCHOR + 32,
                    getBlock: async (n) => block(n),
                },
                32,
            );
            const orchestrator = new BootstrapStepOrchestrator(
                runs,
                steps,
                {
                    processClaimedStep: async ({ run, step }) => {
                        await live.complete({
                            run,
                            step,
                            traceId: input.traceId,
                            sourceJobId: input.sourceJobId,
                        });
                        return terminalStepResult();
                    },
                },
                { wakeBootstrapStep: async () => {} },
                () => now,
            );
            await orchestrator.run({
                runId,
                traceId: input.traceId,
                laneName: "main",
                laneStepKeys: [BOOTSTRAP_STEP_KEY.CollectionLive],
                leaseOwner: "live-owner",
                leaseMs: LEASE_MS,
                maxProgressStaleMs: LEASE_MS,
                claimLimit: 1,
                maxIterations: 1,
                retryPolicy: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
            });
            expect(runs.getRun(runId)!.status).toBe(
                BOOTSTRAP_RUN_STATUS.Completed,
            );
            expect(
                coordinator.registry.getCollection(1, collection.id)!.status,
            ).toBe(COLLECTION_STATUS.Live);
        };
        return {
            ...coordinator,
            input,
            executor,
            runs,
            steps,
            claim,
            finish,
            goLive,
            now: () => now,
            expire: () => {
                now += LEASE_MS + 1;
            },
        };
    }

    it.each(["range", "success", "live"] as const)(
        "ignores an old HEAD response after replacement %s",
        async (stage) => {
            const f = fixture();
            f.claim(OLD_OWNER);
            const head = deferred<number>();
            const stale = f
                .executor(() => head.promise)
                .executeStep({ ...f.input, leaseOwner: OLD_OWNER });
            f.expire();
            f.claim(CURRENT_OWNER);
            await f
                .executor(async () => TARGET)
                .executeStep({ ...f.input, leaseOwner: CURRENT_OWNER });
            if (stage !== "range") await f.finish();
            if (stage === "live") await f.goLive();
            const before = f.steps.getStep(
                f.input.runId,
                BOOTSTRAP_STEP_KEY.Backfill,
            );
            const beforeRun = f.runs.getRun(f.input.runId);
            head.resolve(TARGET + 6);
            expect((await stale).outcome).toBe(
                BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.LeaseLost,
            );
            expect(
                f.steps.getStep(f.input.runId, BOOTSTRAP_STEP_KEY.Backfill),
            ).toEqual(before);
            expect(f.runs.getRun(f.input.runId)).toEqual(beforeRun);
            if (stage !== "live") {
                expect(
                    bootstrapCatchupAuthority(1, f.input.collectionId)
                        ?.targetBlock,
                ).toBe(TARGET);
                if (stage === "range") await f.finish();
                await f.goLive();
            }
        },
    );

    it("rejects an expired claim before a replacement exists", async () => {
        const f = fixture();
        f.claim(OLD_OWNER);
        const head = deferred<number>();
        const stale = f
            .executor(() => head.promise)
            .executeStep({ ...f.input, leaseOwner: OLD_OWNER });
        const before = f.steps.getStep(
            f.input.runId,
            BOOTSTRAP_STEP_KEY.Backfill,
        );
        f.expire();
        head.resolve(TARGET);
        expect((await stale).outcome).toBe(
            BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.LeaseLost,
        );
        expect(
            f.steps.getStep(f.input.runId, BOOTSTRAP_STEP_KEY.Backfill),
        ).toEqual(before);
        expect(f.runs.getRun(f.input.runId)!.status).toBe(
            BOOTSTRAP_RUN_STATUS.Ownership,
        );
        f.claim(CURRENT_OWNER);
        await f
            .executor(async () => TARGET)
            .executeStep({ ...f.input, leaseOwner: CURRENT_OWNER });
        await f.finish();
        await f.goLive();
    });

    it("rejects a claim with another anchor before writing the target", async () => {
        const f = fixture();
        f.claim(CURRENT_OWNER);
        const result = await f
            .executor(async () => TARGET)
            .executeStep({
                ...f.input,
                leaseOwner: CURRENT_OWNER,
                anchorHash: block(ANCHOR + 1).hash,
            });
        expect(result.outcome).toBe(
            BOOTSTRAP_BACKFILL_EXECUTOR_OUTCOME.LeaseLost,
        );
        expect(
            f.steps.getStep(f.input.runId, BOOTSTRAP_STEP_KEY.Backfill)!
                .resultJson,
        ).toBeNull();
        expect(f.runs.getRun(f.input.runId)!.status).toBe(
            BOOTSTRAP_RUN_STATUS.Ownership,
        );
    });

    it("retains the first target even when the same claim samples another head", async () => {
        const f = fixture();
        f.claim(CURRENT_OWNER);
        await f
            .executor(async () => TARGET)
            .executeStep({ ...f.input, leaseOwner: CURRENT_OWNER });
        await f
            .executor(async () => TARGET + 6)
            .scheduleAfterSnapshot({ ...f.input, leaseOwner: CURRENT_OWNER });
        expect(
            bootstrapCatchupAuthority(1, f.input.collectionId)?.targetBlock,
        ).toBe(TARGET);
        await f.finish();
        await f.goLive();
    });

    it.each([1, 3])(
        "does not settle an old RPC failure against a replacement claim (maxAttempts=%s)",
        async (maxAttempts) => {
            const f = fixture();
            const head = deferred<number>();
            const started = deferred<void>();
            const staleExecutor = f.executor(() => {
                started.resolve();
                return head.promise;
            });
            const orchestrator = new BootstrapStepOrchestrator(
                f.runs,
                f.steps,
                {
                    processClaimedStep: async ({ leaseOwner }) => {
                        await staleExecutor.executeStep({
                            ...f.input,
                            leaseOwner,
                        });
                        return runningStepResult(f.now() + 100);
                    },
                },
                { wakeBootstrapStep: async () => {} },
                f.now,
            );
            const pending = orchestrator.run({
                runId: f.input.runId,
                traceId: f.input.traceId,
                laneName: "main",
                laneStepKeys: [BOOTSTRAP_STEP_KEY.Backfill],
                leaseOwner: OLD_OWNER,
                leaseMs: LEASE_MS,
                maxProgressStaleMs: LEASE_MS,
                claimLimit: 1,
                maxIterations: 1,
                retryPolicy: { maxAttempts, baseDelayMs: 1, maxDelayMs: 1 },
            });
            await started.promise;
            f.expire();
            f.claim(CURRENT_OWNER);
            await f
                .executor(async () => TARGET)
                .executeStep({ ...f.input, leaseOwner: CURRENT_OWNER });
            const before = f.steps.getStep(
                f.input.runId,
                BOOTSTRAP_STEP_KEY.Backfill,
            );
            head.reject(new Error("old request failed"));
            await pending;
            expect(
                f.steps.getStep(f.input.runId, BOOTSTRAP_STEP_KEY.Backfill),
            ).toEqual(before);
            await f.finish();
            await f.goLive();
        },
    );
});
