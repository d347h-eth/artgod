import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { TERRAFORMS_EXTENSION_KEY } from "@artgod/shared/extensions/terraforms";
import {
    BOOTSTRAP_COLLECTION_LIVE_EXECUTOR_OUTCOME,
    BootstrapCollectionLiveExecutor,
} from "../src/application/bootstrap-collection-live-executor.js";
import { buildBootstrapBackfillTerminalStepResult } from "../src/application/bootstrap-backfill-executor.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { SqliteBootstrapRuns } from "../src/infra/bootstrap/sqlite-runs.js";
import { SqliteBootstrapSteps } from "../src/infra/bootstrap/sqlite-steps.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import {
    advanceChainSyncRevision,
    captureChainSyncCheckpoint,
} from "../src/infra/storage/sqlite-chain-revisions.js";
import { persistCanonicalBlocks } from "../src/infra/storage/sqlite-canonical-headers.js";
import { SqliteChainProgress } from "../src/infra/storage/sqlite-chain-progress.js";
import type { RpcProviderPort } from "../src/ports/rpc.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import { insertCollection } from "./helpers/ownership-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const CHAIN_ID = 1;
const ANCHOR = 100;
const TARGET = 105;
const DEPTH = 32;
const LEASE = "bootstrap-finalization-test";
const ADDRESS = "0x0000000000000000000000000000000000000001";

describe("atomic bootstrap finalization", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    function fixture() {
        const collectionId = insertCollection({
            chainId: CHAIN_ID,
            slug: "finalization",
            address: ADDRESS,
            anchorBlock: ANCHOR,
        });
        // Finalization starts with an already applied prefix. Coordinator admission
        // and range application are exercised by their separate integration tests.
        persistCanonicalBlocks(
            captureChainSyncCheckpoint(CHAIN_ID),
            Array.from({ length: TARGET - ANCHOR + 1 }, (_, i) =>
                block(ANCHOR + i),
            ),
            () => false,
        );
        db.prepare(
            "INSERT INTO chain_sync_progress(chain_id,revision,anchor_block,anchor_hash,applied_block,applied_hash) VALUES (?,?,?,?,?,?)",
        ).run(
            CHAIN_ID,
            0,
            ANCHOR,
            block(ANCHOR).hash,
            TARGET,
            block(TARGET).hash,
        );
        db.prepare(
            "INSERT INTO collection_sync_progress(chain_id,collection_id,revision,anchor_block,anchor_hash,applied_block,applied_hash) VALUES (?,?,?,?,?,?,?)",
        ).run(
            CHAIN_ID,
            collectionId,
            0,
            ANCHOR,
            block(ANCHOR).hash,
            TARGET,
            block(TARGET).hash,
        );
        const progress = new SqliteChainProgress();
        db.prepare("UPDATE collections SET status=? WHERE collection_id=?").run(
            COLLECTION_STATUS.Bootstrapping,
            collectionId,
        );
        const runId = Number(
            db
                .prepare(
                    "INSERT INTO bootstrap_runs(chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,status,anchor_block,anchor_block_hash,anchor_block_timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                )
                .run(
                    CHAIN_ID,
                    collectionId,
                    "finalization",
                    ADDRESS,
                    "erc721",
                    BOOTSTRAP_METADATA_MODE.Strict,
                    BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
                    BOOTSTRAP_RUN_STATUS.Backfill,
                    ANCHOR,
                    block(ANCHOR).hash,
                    block(ANCHOR).timestamp,
                ).lastInsertRowid,
        );
        db.prepare(
            "INSERT INTO bootstrap_run_steps(run_id,step_key,status,result_json) VALUES (?,?,?,?)",
        ).run(
            runId,
            BOOTSTRAP_STEP_KEY.Backfill,
            BOOTSTRAP_STEP_STATUS.Succeeded,
            JSON.stringify(
                buildBootstrapBackfillTerminalStepResult({
                    fromBlock: ANCHOR + 1,
                    toBlock: TARGET,
                    liveBlock: TARGET,
                }),
            ),
        );
        db.prepare(
            "INSERT INTO bootstrap_run_steps(run_id,step_key,status) VALUES (?,?,?)",
        ).run(
            runId,
            BOOTSTRAP_STEP_KEY.Ownership,
            BOOTSTRAP_STEP_STATUS.Succeeded,
        );
        const now = Date.now();
        db.prepare(
            "INSERT INTO bootstrap_run_steps(run_id,step_key,status,lease_owner,lease_until) VALUES (?,?,?,?,?)",
        ).run(
            runId,
            BOOTSTRAP_STEP_KEY.CollectionLive,
            BOOTSTRAP_STEP_STATUS.Running,
            LEASE,
            now + 60_000,
        );
        const runs = new SqliteBootstrapRuns();
        const steps = new SqliteBootstrapSteps();
        const registry = new SqliteCollectionRegistry(() => now);
        const input = {
            run: runs.getRun(runId)!,
            step: steps.getStep(runId, BOOTSTRAP_STEP_KEY.CollectionLive)!,
            traceId: "finalization",
            sourceJobId: "finalization",
        };
        const executor = (
            rpc: Pick<RpcProviderPort, "getBlockNumber" | "getBlock">,
        ) =>
            new BootstrapCollectionLiveExecutor(
                registry,
                runs,
                steps,
                new SqliteBootstrapStorage(),
                progress,
                rpc,
                DEPTH,
            );
        const states = () => ({
            collection: registry.getCollection(CHAIN_ID, collectionId)?.status,
            run: runs.getRun(runId)?.status,
            step: steps.getStep(runId, BOOTSTRAP_STEP_KEY.CollectionLive)
                ?.status,
        });
        const events = () =>
            db
                .prepare(
                    "SELECT event_code FROM bootstrap_run_events WHERE run_id=?",
                )
                .all(runId);
        return {
            progress,
            collectionId,
            runId,
            now,
            runs,
            steps,
            registry,
            input,
            executor,
            states,
            events,
            finalStats: () =>
                (
                    db
                        .prepare(
                            "SELECT COUNT(*) AS count FROM queue_outbox WHERE chain_id=? AND collection_id=?",
                        )
                        .get(CHAIN_ID, collectionId) as { count: number }
                ).count,
        };
    }

    function rpc(head = ANCHOR + DEPTH, beforeAnchor = () => {}) {
        return {
            getBlockNumber: async () => head,
            getBlock: async (number: number, options?: { fresh: boolean }) => {
                expect(options?.fresh).toBe(true);
                beforeAnchor();
                return block(number);
            },
        };
    }

    it("waits below the supported depth and atomically completes at the exact boundary", async () => {
        const f = fixture();
        const waiting = await f
            .executor(rpc(ANCHOR + DEPTH - 1))
            .complete(f.input);
        expect(waiting.outcome).toBe(
            BOOTSTRAP_COLLECTION_LIVE_EXECUTOR_OUTCOME.AwaitingAppliedProgress,
        );
        expect(f.states()).toEqual({
            collection: COLLECTION_STATUS.Bootstrapping,
            run: BOOTSTRAP_RUN_STATUS.Backfill,
            step: BOOTSTRAP_STEP_STATUS.Running,
        });
        expect(f.events()).toEqual([]);
        expect(f.finalStats()).toBe(0);

        const executor = f.executor(rpc());
        expect((await executor.complete(f.input)).outcome).toBe(
            BOOTSTRAP_COLLECTION_LIVE_EXECUTOR_OUTCOME.Completed,
        );
        expect(f.states()).toEqual({
            collection: COLLECTION_STATUS.Live,
            run: BOOTSTRAP_RUN_STATUS.Completed,
            step: BOOTSTRAP_STEP_STATUS.Succeeded,
        });
        expect(f.events()).toEqual([
            { event_code: BOOTSTRAP_RUN_EVENT_CODE.RunCompleted },
        ]);
        expect(f.finalStats()).toBe(1);
        // Lost-reply repetition preserves the same transition and journal event.
        await executor.complete(f.input);
        expect(f.events()).toHaveLength(1);
        expect(f.finalStats()).toBe(1);
    });

    it("rejects a fresh anchor disagreement without publishing liveness", async () => {
        const f = fixture();
        await expect(
            f
                .executor({ ...rpc(), getBlock: async () => block(ANCHOR + 1) })
                .complete(f.input),
        ).rejects.toThrow(ChainSyncConflict);
        expect(f.states().collection).toBe(COLLECTION_STATUS.Bootstrapping);
        expect(f.events()).toEqual([]);
    });

    it.each([
        "revision",
        "dispute",
        "failed-run",
        "revoked-lease",
        "expired-lease",
        "newer-run",
        "changed-target",
    ] as const)(
        "rejects %s arriving between RPC and the final writer",
        async (change) => {
            const f = fixture();
            const changed = () => {
                if (change === "revision") advanceChainSyncRevision(CHAIN_ID);
                if (change === "dispute")
                    f.progress.retainDispute({
                        checkpoint: captureChainSyncCheckpoint(CHAIN_ID),
                        chainId: CHAIN_ID,
                        blockNumber: TARGET,
                        blockHash: block(TARGET).hash,
                    });
                if (change === "failed-run")
                    f.runs.updateRunStatus(
                        f.runId,
                        BOOTSTRAP_RUN_STATUS.Failed,
                        { code: "test-reorg", message: "Invalidated by reorg" },
                    );
                if (change === "revoked-lease")
                    db.prepare(
                        "UPDATE bootstrap_run_steps SET lease_owner=? WHERE run_id=? AND step_key=?",
                    ).run(
                        "replacement-worker",
                        f.runId,
                        BOOTSTRAP_STEP_KEY.CollectionLive,
                    );
                if (change === "expired-lease")
                    db.prepare(
                        "UPDATE bootstrap_run_steps SET lease_until=? WHERE run_id=? AND step_key=?",
                    ).run(f.now, f.runId, BOOTSTRAP_STEP_KEY.CollectionLive);
                if (change === "newer-run") {
                    f.runs.updateRunStatus(
                        f.runId,
                        BOOTSTRAP_RUN_STATUS.Failed,
                        {
                            code: "test-replacement",
                            message: "Replaced by a fresh bootstrap",
                        },
                    );
                    db.prepare(
                        "INSERT INTO bootstrap_runs(chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,status) SELECT chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,? FROM bootstrap_runs WHERE run_id=?",
                    ).run(BOOTSTRAP_RUN_STATUS.Requested, f.runId);
                }
                if (change === "changed-target")
                    db.prepare(
                        "UPDATE bootstrap_run_steps SET result_json=? WHERE run_id=? AND step_key=?",
                    ).run(
                        JSON.stringify(
                            buildBootstrapBackfillTerminalStepResult({
                                fromBlock: ANCHOR + 1,
                                toBlock: TARGET + 1,
                                liveBlock: TARGET + 1,
                            }),
                        ),
                        f.runId,
                        BOOTSTRAP_STEP_KEY.Backfill,
                    );
            };
            await expect(
                f.executor(rpc(ANCHOR + DEPTH, changed)).complete(f.input),
            ).rejects.toThrow(ChainSyncConflict);
            expect(f.states().collection).toBe(COLLECTION_STATUS.Bootstrapping);
            expect(f.states().run).not.toBe(BOOTSTRAP_RUN_STATUS.Completed);
            expect(f.states().step).not.toBe(BOOTSTRAP_STEP_STATUS.Succeeded);
            expect(f.events()).toEqual([]);
            expect(f.finalStats()).toBe(0);
        },
    );

    it("rolls back collection and step completion if completing the run fails", async () => {
        const f = fixture();
        db.exec(
            `CREATE TRIGGER reject_bootstrap_completion BEFORE UPDATE OF status ON bootstrap_runs WHEN NEW.status='${BOOTSTRAP_RUN_STATUS.Completed}' BEGIN SELECT RAISE(ABORT, 'test completion failure'); END`,
        );
        await expect(f.executor(rpc()).complete(f.input)).rejects.toThrow(
            "test completion failure",
        );
        expect(f.states()).toEqual({
            collection: COLLECTION_STATUS.Bootstrapping,
            run: BOOTSTRAP_RUN_STATUS.Backfill,
            step: BOOTSTRAP_STEP_STATUS.Running,
        });
        expect(f.events()).toEqual([]);
        expect(f.finalStats()).toBe(0);
    });

    it("rolls back the entire lifecycle transition if durable final-stat retention fails", async () => {
        const f = fixture();
        db.exec(
            "CREATE TRIGGER reject_final_stats BEFORE INSERT ON queue_outbox BEGIN SELECT RAISE(ABORT, 'test final-stat failure'); END",
        );
        await expect(f.executor(rpc()).complete(f.input)).rejects.toThrow(
            "test final-stat failure",
        );
        expect(f.states()).toEqual({
            collection: COLLECTION_STATUS.Bootstrapping,
            run: BOOTSTRAP_RUN_STATUS.Backfill,
            step: BOOTSTRAP_STEP_STATUS.Running,
        });
        expect(f.events()).toEqual([]);
        expect(f.finalStats()).toBe(0);
        expect(
            db
                .prepare("SELECT COUNT(*) AS count FROM metadata_refresh_runs")
                .get(),
        ).toEqual({ count: 0 });
    });

    it("leaves extension-owned final statistics behind their artifact completion gate", async () => {
        const f = fixture();
        db.prepare(
            "UPDATE bootstrap_runs SET request_extension_key=? WHERE run_id=?",
        ).run(TERRAFORMS_EXTENSION_KEY, f.runId);
        f.input.run = f.runs.getRun(f.runId)!;
        await f.executor(rpc()).complete(f.input);
        expect(f.states().run).toBe(BOOTSTRAP_RUN_STATUS.Completed);
        expect(f.finalStats()).toBe(0);
    });
});
