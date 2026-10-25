import { COLLECTION_TOKEN_SCOPE_KIND } from "@artgod/shared/collections/token-scope";
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
import { COLLECTION_STANDARD, COLLECTION_STATUS } from "@artgod/shared/types";
import { BootstrapAnchorExecutor } from "../src/application/bootstrap-anchor-executor.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteBootstrapSteps } from "../src/infra/bootstrap/sqlite-steps.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { SqliteBootstrapRuns } from "../src/infra/bootstrap/sqlite-runs.js";
import { SqliteMetadataDomain } from "../src/infra/domain/metadata.js";
import { SqliteCollectionExtensions } from "../src/infra/collection-extensions/sqlite.js";
import { METADATA_REFRESH_REASON } from "../src/domain/domain-jobs.js";
import { BOOTSTRAP_REORG_FAILURE } from "../src/infra/bootstrap/sqlite-reorg-invalidation.js";
import { REORG_RECOVERY_PHASE } from "../src/domain/reorg-recovery.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import { authorizeCoordinatorBootstrapCatchup } from "./helpers/coordinated-sync-fixture.js";
import {
    REORG_FIXTURE as F,
    RecoveryRpc,
    reorgRecoveryServices,
    seedRecoveryHistory,
    retainCanonicalCheckFixture,
} from "./helpers/reorg-recovery-fixture.js";

describe("authoritative reorg bootstrap invalidation", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    function collection(
        id: number,
        chainId: number,
        anchor: number,
        live = false,
    ) {
        const contract = `0x${id.toString(16).padStart(40, "0")}`;
        db.prepare(
            "INSERT INTO collections(collection_id,chain_id,slug,address,standard,status,bootstrap_anchor_block,token_scope_kind) VALUES (?,?,?,?,?,?,?,?)",
        ).run(
            id,
            chainId,
            `reorg-bootstrap-${id}`,
            contract,
            COLLECTION_STANDARD.Erc721,
            live ? COLLECTION_STATUS.Live : COLLECTION_STATUS.Bootstrapping,
            anchor,
            COLLECTION_TOKEN_SCOPE_KIND.AllContractTokens,
        );
        db.prepare(
            "INSERT INTO bootstrap_runs(run_id,chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,status,anchor_block,anchor_block_hash,anchor_block_timestamp) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
            id,
            chainId,
            id,
            `reorg-bootstrap-${id}`,
            contract,
            COLLECTION_STANDARD.Erc721,
            BOOTSTRAP_METADATA_MODE.Strict,
            BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
            live
                ? BOOTSTRAP_RUN_STATUS.Completed
                : BOOTSTRAP_RUN_STATUS.Ownership,
            anchor,
            syncBlockFixture(anchor).hash,
            anchor * 12,
        );
        db.prepare(
            "INSERT INTO bootstrap_run_steps(run_id,step_key,status,lease_owner,lease_until) VALUES (?,?,?,?,?)",
        ).run(
            id,
            BOOTSTRAP_STEP_KEY.Ownership,
            live
                ? BOOTSTRAP_STEP_STATUS.Succeeded
                : BOOTSTRAP_STEP_STATUS.Running,
            "in-flight",
            Date.now() + 60_000,
        );
        db.prepare(
            "INSERT INTO token_metadata(chain_id,collection_id,contract_address,token_id,uri) VALUES (?,?,?,?,?)",
        ).run(chainId, id, contract, "1", "fixture://metadata");
        const task = {
            runId: id,
            chainId,
            collectionId: id,
            contract,
            tokenId: "1",
            standard: COLLECTION_STANDARD.Erc721,
            anchorBlock: anchor,
            anchorHash: syncBlockFixture(anchor).hash,
            anchorTimestamp: anchor * 12,
        };
        new SqliteBootstrapStorage().insertOwnershipTasks([task]);
        return task;
    }

    function state(id: number) {
        return db
            .prepare(
                "SELECT c.status AS collectionStatus,c.bootstrap_anchor_block AS anchor,r.status AS runStatus,r.error_code AS errorCode FROM collections c JOIN bootstrap_runs r ON r.collection_id=c.collection_id AND r.chain_id=c.chain_id WHERE c.collection_id=?",
            )
            .get(id);
    }

    it.each([false, true])(
        "rejects an anchor RPC reply after confirmed recovery (replacement run: %s)",
        async (replacement) => {
            seedRecoveryHistory();
            const task = collection(101, 1, 90);
            db.prepare(
                "UPDATE collections SET status=?,bootstrap_anchor_block=NULL WHERE collection_id=?",
            ).run(COLLECTION_STATUS.Prepared, task.collectionId);
            db.prepare(
                "UPDATE bootstrap_runs SET status=?,anchor_block=NULL,anchor_block_hash=NULL,anchor_block_timestamp=NULL WHERE run_id=?",
            ).run(BOOTSTRAP_RUN_STATUS.Queued, task.runId);
            db.prepare(
                "INSERT INTO bootstrap_run_steps(run_id,step_key,status,lease_owner,lease_until) VALUES (?,?,?,?,?)",
            ).run(
                task.runId,
                BOOTSTRAP_STEP_KEY.Anchor,
                BOOTSTRAP_STEP_STATUS.Running,
                "late-anchor",
                Date.now() + 60_000,
            );
            const runs = new SqliteBootstrapRuns();
            const run = runs.getRun(task.runId)!;
            const services = reorgRecoveryServices(new RecoveryRpc());
            const executor = new BootstrapAnchorExecutor(
                {
                    getBlockNumber: async () => 110,
                    getBlock: async (number) => {
                        await services.recovery.checkBlock(
                            retainCanonicalCheckFixture(
                                services.storage,
                                F.Orphan,
                            ),
                        );
                        if (replacement) {
                            db.prepare(
                                "INSERT INTO bootstrap_runs(run_id,chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,status,anchor_block,anchor_block_hash,anchor_block_timestamp) SELECT 201,chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,?,200,?,200 FROM bootstrap_runs WHERE run_id=?",
                            ).run(
                                BOOTSTRAP_RUN_STATUS.Metadata,
                                syncBlockFixture(200).hash,
                                task.runId,
                            );
                            db.prepare(
                                "UPDATE collections SET status=?,bootstrap_anchor_block=200 WHERE collection_id=?",
                            ).run(
                                COLLECTION_STATUS.Bootstrapping,
                                task.collectionId,
                            );
                        }
                        return syncBlockFixture(number);
                    },
                },
                runs,
                new SqliteBootstrapSteps(),
                new SqliteCollectionRegistry(),
            );
            await expect(
                executor.anchor({
                    run,
                    reorgDepth: 10,
                    leaseOwner: "late-anchor",
                }),
            ).rejects.toThrow("no longer owns");
            expect(runs.getRun(task.runId)?.status).toBe(
                BOOTSTRAP_RUN_STATUS.Failed,
            );
            expect(
                db
                    .prepare(
                        "SELECT status,bootstrap_anchor_block AS anchor FROM collections WHERE collection_id=?",
                    )
                    .get(task.collectionId),
            ).toEqual({
                status: replacement
                    ? COLLECTION_STATUS.Bootstrapping
                    : COLLECTION_STATUS.Prepared,
                anchor: replacement ? 200 : null,
            });
            expect(runs.getRun(task.runId)?.anchorBlock).toBeNull();
            if (replacement) expect(runs.getRun(201)?.anchorBlock).toBe(200);
        },
    );

    it("fails all active chain runs, discards orphaned live snapshots, and fences late outputs while healthy collections recover", async () => {
        const healthy = seedRecoveryHistory();
        const earlier = collection(101, 1, 90);
        const later = collection(102, 1, 105);
        collection(103, 1, 105, true);
        collection(104, 2, 105);
        collection(105, 1, 100, true);
        // Existing post-live metadata retry reuses the original run status;
        // that does not make the already live collection a new bootstrap.
        db.prepare("UPDATE bootstrap_runs SET status=? WHERE run_id=105").run(
            BOOTSTRAP_RUN_STATUS.Metadata,
        );
        collection(106, 1, 90);
        db.prepare(
            "UPDATE collections SET status=?,bootstrap_anchor_block=NULL WHERE collection_id=106",
        ).run(COLLECTION_STATUS.Prepared);
        db.prepare(
            "UPDATE bootstrap_runs SET anchor_block=NULL,anchor_block_hash=NULL,status=? WHERE run_id=106",
        ).run(BOOTSTRAP_RUN_STATUS.Requested);
        const rpc = new RecoveryRpc();
        const services = reorgRecoveryServices(rpc);
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Orphan),
        );
        expect(services.storage.captureSyncCheckpoint(1).revision).toBe(1);
        expect(services.recoveries.getRecovery(1)?.phase).toBe(
            REORG_RECOVERY_PHASE.Resync,
        );
        for (const id of [101, 102, 103, 106]) {
            expect(state(id)).toEqual({
                collectionStatus: COLLECTION_STATUS.Prepared,
                anchor: null,
                runStatus: BOOTSTRAP_RUN_STATUS.Failed,
                errorCode: BOOTSTRAP_REORG_FAILURE.Code,
            });
            expect(
                db
                    .prepare(
                        "SELECT 1 FROM token_metadata WHERE collection_id=?",
                    )
                    .get(id),
            ).toBeUndefined();
            expect(
                db
                    .prepare(
                        "SELECT 1 FROM bootstrap_ownership_snapshot_tasks WHERE run_id=?",
                    )
                    .get(id),
            ).toBeUndefined();
        }
        expect(state(104)).toMatchObject({
            collectionStatus: COLLECTION_STATUS.Bootstrapping,
            runStatus: BOOTSTRAP_RUN_STATUS.Ownership,
        });
        expect(state(105)).toMatchObject({
            collectionStatus: COLLECTION_STATUS.Live,
            runStatus: BOOTSTRAP_RUN_STATUS.Metadata,
        });
        expect(
            db
                .prepare("SELECT status FROM collections WHERE collection_id=?")
                .get(healthy.collectionId),
        ).toEqual({ status: COLLECTION_STATUS.Live });
        expect(
            rpc.ownerReads.every((block) => block.blockNumber === F.Fork),
        ).toBe(true);
        const storage = new SqliteBootstrapStorage();
        expect(() => storage.insertOwnershipTasks([later])).toThrow(
            "no longer owns",
        );
        expect(() => storage.insertMetadataTasks([earlier])).toThrow(
            "no longer owns",
        );
        expect(
            storage.markOwnershipTaskSucceeded({
                runId: later.runId,
                tokenId: "1",
                attempts: 1,
                owner: F.Owner,
                block: {
                    chainId: 1,
                    blockNumber: later.anchorBlock,
                    blockHash: later.anchorHash,
                },
            }),
        ).toBe(false);
        new SqliteBootstrapRuns().updateRunStatus(
            later.runId,
            BOOTSTRAP_RUN_STATUS.Completed,
        );
        expect(state(later.runId)).toMatchObject({
            runStatus: BOOTSTRAP_RUN_STATUS.Failed,
        });
        for (
            let attempt = 0;
            attempt < 10 && services.recoveries.getRecovery(1);
            attempt++
        )
            await services.executor.runDue();
        expect(services.recoveries.getRecovery(1)).toBeNull();
        expect(services.progress.chainProgress(1)?.applied.number).toBe(F.Head);
    });

    it("rejects bootstrap metadata fetched before recovery instead of recreating cleaned tokens and attributes", async () => {
        seedRecoveryHistory();
        const task = collection(101, 1, 90);
        const services = reorgRecoveryServices(new RecoveryRpc());
        const metadata = new SqliteMetadataDomain(
            { resolveTokenUri: async () => "fixture://token" },
            {
                fetchMetadata: async () => {
                    await services.recovery.checkBlock(
                        retainCanonicalCheckFixture(services.storage, F.Orphan),
                    );
                    return {
                        uri: "fixture://token",
                        name: "Late output",
                        attributes: [{ traitType: "color", value: "blue" }],
                        rawJson: "{}",
                    };
                },
            },
        );
        await expect(
            metadata.handleMetadataRefresh(
                {
                    chainId: 1,
                    collectionId: task.collectionId,
                    tokenId: "1",
                    standard: COLLECTION_STANDARD.Erc721,
                    reason: METADATA_REFRESH_REASON.BootstrapSnapshot,
                },
                { runId: task.runId },
            ),
        ).rejects.toThrow("no longer owns");
        expect(
            db
                .prepare("SELECT 1 FROM tokens WHERE collection_id=?")
                .get(task.collectionId),
        ).toBeUndefined();
        expect(
            db
                .prepare("SELECT 1 FROM token_metadata WHERE collection_id=?")
                .get(task.collectionId),
        ).toBeUndefined();
        expect(
            db
                .prepare("SELECT 1 FROM token_attributes WHERE collection_id=?")
                .get(task.collectionId),
        ).toBeUndefined();
    });

    it.each([true, false])(
        "fences late extension output after invalidation (bootstrap=%s)",
        async (bootstrap) => {
            seedRecoveryHistory();
            const task = collection(101, 1, bootstrap ? 90 : 105, !bootstrap);
            const store = new SqliteCollectionExtensions().forRefresh(
                task,
                bootstrap ? task.runId : undefined,
            )!;
            const token = {
                chainId: 1,
                collectionId: task.collectionId,
                contractAddress: task.contract,
                tokenId: "synthetic",
                extensionKey: "reorg-fixture-extension",
            };
            const artifact = {
                ...token,
                artifactRef: "render",
                uri: null,
                rawJson: null,
                attributesJson: null,
                image: "fixture://image",
                animationUrl: null,
                htmlContent: null,
            };
            const attributes = [{ key: "color", value: "blue" }];
            expect(
                store.publishSyntheticToken({ ...token, artifact, attributes })
                    .published,
            ).toBe(true);
            const services = reorgRecoveryServices(new RecoveryRpc());
            await services.recovery.checkBlock(
                retainCanonicalCheckFixture(services.storage, F.Orphan),
            );
            expect(() =>
                store.publishSyntheticToken({ ...token, artifact, attributes }),
            ).toThrow(/no longer owns|changed while/);
            expect(() => store.upsertArtifact(artifact)).toThrow(
                /no longer owns|changed while/,
            );
            expect(() =>
                store.replaceTokenAttributes({ ...token, attributes }),
            ).toThrow(/no longer owns|changed while/);
            expect(() =>
                store.replaceSyntheticTokenWithToken({
                    syntheticToken: token,
                    token: { ...token, tokenId: "minted" },
                    artifacts: [artifact],
                    attributes,
                }),
            ).toThrow(/no longer owns|changed while/);
            expect(
                new SqliteCollectionExtensions().forRefresh(task),
            ).toBeNull();
            for (const table of [
                "tokens",
                "token_extension_artifacts",
                "token_attributes",
                "collection_extension_synthetic_token_retirements",
            ])
                expect(
                    db
                        .prepare(`SELECT 1 FROM ${table} WHERE collection_id=?`)
                        .get(task.collectionId),
                ).toBeUndefined();
        },
    );

    it.each(["paused", "delegated-backfill"])(
        "preserves ordinary enrichment for an accepted %s scope",
        async (mode) => {
            seedRecoveryHistory();
            const task = collection(101, 1, 90, mode === "paused");
            if (mode === "paused") {
                db.prepare(
                    "UPDATE collections SET status=? WHERE collection_id=?",
                ).run(COLLECTION_STATUS.Paused, task.collectionId);
            } else {
                expect(
                    new SqliteCollectionExtensions().forRefresh(task),
                ).toBeNull();
                db.prepare(
                    "UPDATE bootstrap_runs SET status=? WHERE run_id=?",
                ).run(BOOTSTRAP_RUN_STATUS.Failed, task.runId);
                authorizeCoordinatorBootstrapCatchup(
                    task.collectionId,
                    task.anchorBlock,
                    F.head,
                );
            }
            expect(
                new SqliteCollectionExtensions().forRefresh(task),
            ).not.toBeNull();
            const metadata = new SqliteMetadataDomain(
                { resolveTokenUri: async () => "fixture://token" },
                {
                    fetchMetadata: async () => ({
                        uri: "fixture://token",
                        attributes: [],
                        rawJson: "{}",
                    }),
                },
            );
            expect(
                await metadata.handleMetadataRefresh({
                    chainId: task.chainId,
                    collectionId: task.collectionId,
                    tokenId: "1",
                    standard: COLLECTION_STANDARD.Erc721,
                    reason: METADATA_REFRESH_REASON.BootstrapSnapshot,
                }),
            ).not.toBeNull();
            expect(
                db
                    .prepare("SELECT 1 FROM tokens WHERE collection_id=?")
                    .get(task.collectionId),
            ).toBeDefined();
        },
    );

    it("rejects ordinary metadata acquired before a live ownership anchor was invalidated", async () => {
        seedRecoveryHistory();
        const task = collection(101, 1, 105, true);
        const services = reorgRecoveryServices(new RecoveryRpc());
        const metadata = new SqliteMetadataDomain(
            { resolveTokenUri: async () => "fixture://token" },
            {
                fetchMetadata: async () => {
                    await services.recovery.checkBlock(
                        retainCanonicalCheckFixture(services.storage, F.Orphan),
                    );
                    return {
                        uri: "fixture://token",
                        attributes: [],
                        rawJson: "{}",
                    };
                },
            },
        );
        const payload = {
            chainId: 1,
            collectionId: task.collectionId,
            tokenId: "1",
            standard: COLLECTION_STANDARD.Erc721,
            reason: METADATA_REFRESH_REASON.BootstrapSnapshot,
        };
        await expect(metadata.handleMetadataRefresh(payload)).rejects.toThrow(
            "changed while",
        );
        expect(await metadata.handleMetadataRefresh(payload)).toBeNull();
        expect(
            db
                .prepare("SELECT 1 FROM tokens WHERE collection_id=?")
                .get(task.collectionId),
        ).toBeUndefined();
    });

    it("keeps failed cleanup and rollback atomic, then retries the same recovery", async () => {
        seedRecoveryHistory();
        collection(101, 1, 90);
        let now = Date.now();
        const services = reorgRecoveryServices(new RecoveryRpc(), {
            now: () => now,
            retryDelayMs: 100,
        });
        db.exec(
            "CREATE TEMP TRIGGER refuse_bootstrap_cleanup BEFORE DELETE ON token_metadata WHEN OLD.collection_id=101 BEGIN SELECT RAISE(ABORT,'cleanup unavailable'); END",
        );
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, F.Orphan),
        );
        expect(services.storage.captureSyncCheckpoint(1).revision).toBe(0);
        expect(services.storage.getBlockHash(1, F.Orphan)).toBe(
            syncBlockFixture(F.Orphan).hash,
        );
        expect(state(101)).toMatchObject({
            collectionStatus: COLLECTION_STATUS.Bootstrapping,
            runStatus: BOOTSTRAP_RUN_STATUS.Ownership,
        });
        expect(services.recoveries.getRecovery(1)?.phase).toBe(
            REORG_RECOVERY_PHASE.AwaitingAncestor,
        );
        db.exec("DROP TRIGGER refuse_bootstrap_cleanup");
        now += 100;
        await services.recovery.resumeDue();
        expect(services.storage.captureSyncCheckpoint(1).revision).toBe(1);
        expect(state(101)).toMatchObject({
            collectionStatus: COLLECTION_STATUS.Prepared,
            runStatus: BOOTSTRAP_RUN_STATUS.Failed,
        });
    });

    it("uses retained predecessor lineage to recover below the original shared starting block", async () => {
        seedRecoveryHistory();
        // Headers 100..105 are connected; the original shared acquisition
        // starting point was 104, with earlier headers retained for ancestry.
        db.prepare(
            "UPDATE chain_sync_progress SET anchor_block=?,anchor_hash=? WHERE chain_id=1",
        ).run(104, syncBlockFixture(104).hash);
        const services = reorgRecoveryServices(new RecoveryRpc(102), {
            reorgDepth: 4,
        });
        await services.recovery.checkBlock(
            retainCanonicalCheckFixture(services.storage, 105),
        );
        expect(services.storage.captureSyncCheckpoint(1).revision).toBe(1);
        expect(services.progress.chainProgress(1)?.anchor.number).toBe(102);
        expect(services.progress.chainProgress(1)?.applied.number).toBe(102);
        expect(services.recoveries.getRecovery(1)?.phase).toBe(
            REORG_RECOVERY_PHASE.Resync,
        );
    });

    it.each([false, true])(
        "settles a checked predecessor below shared startup (actual fork=%s)",
        async (forked) => {
            seedRecoveryHistory();
            db.prepare(
                "UPDATE chain_sync_progress SET anchor_block=?,anchor_hash=? WHERE chain_id=1",
            ).run(104, syncBlockFixture(104).hash);
            const services = reorgRecoveryServices(
                new RecoveryRpc(forked ? 102 : 200),
                { reorgDepth: 4 },
            );
            const check = retainCanonicalCheckFixture(services.storage, 103);
            if (forked) {
                await services.recovery.checkBlock(check);
                expect(services.storage.captureSyncCheckpoint(1).revision).toBe(
                    1,
                );
                expect(services.progress.chainProgress(1)?.anchor.number).toBe(
                    102,
                );
                expect(services.recoveries.getRecovery(1)?.phase).toBe(
                    REORG_RECOVERY_PHASE.Resync,
                );
            } else {
                services.recoveries.retainMismatch({
                    checkpoint: check.checkpoint,
                    recoveryId: "transient-predecessor",
                    checkedBlock: 103,
                    storedHash: check.blockHash,
                    observedHash: syncBlockFixture(10103).hash,
                    now: Date.now(),
                });
                await services.recovery.resumeDue();
                await services.recovery.checkDue();
                expect(services.storage.captureSyncCheckpoint(1).revision).toBe(
                    0,
                );
                expect(services.progress.chainProgress(1)?.anchor.number).toBe(
                    104,
                );
                expect(services.recoveries.getRecovery(1)).toBeNull();
            }
        },
    );
});
