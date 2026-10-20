import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_TASK_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import { InstallBootstrapOwnershipSnapshot } from "../src/application/bootstrap-ownership-installation.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import {
    captureChainSyncCheckpoint,
    advanceChainSyncRevision,
} from "../src/infra/storage/sqlite-chain-revisions.js";
import { prepareBootstrapSnapshotFixture } from "./helpers/bootstrap-snapshot-fixture.js";
import {
    insertCollection,
    selectBalanceOwners,
} from "./helpers/ownership-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const CONTRACT = `0x${"ab".repeat(20)}`;
const OWNER = `0x${"11".repeat(20)}`;
const BUYER = `0x${"22".repeat(20)}`;
const HASH = `0x${"cc".repeat(32)}` as const;
const ANCHOR = {
    number: 100,
    hash: HASH,
    parentHash: `0x${"dd".repeat(32)}` as const,
    timestamp: 1200,
    transactions: [],
};

describe("bootstrap ownership base installation", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        db.exec(
            [
                "DELETE FROM collection_ownership_bases",
                "DELETE FROM collection_sync_progress",
                "DELETE FROM chain_sync_progress",
                "DELETE FROM chain_reorg_recoveries",
                "DELETE FROM chain_sync_revisions",
                "DELETE FROM bootstrap_run_steps",
                "DELETE FROM bootstrap_runs",
                "DELETE FROM bootstrap_ownership_snapshot_tasks",
                "DELETE FROM nft_balance_snapshots",
                "DELETE FROM nft_balances",
                "DELETE FROM erc721_ownership_checkpoints",
                "DELETE FROM blocks",
                "DELETE FROM collections",
            ].join(";"),
        );
    });

    function fixture() {
        const collectionId = insertCollection({
            chainId: 1,
            slug: "base-installation",
            address: CONTRACT,
            anchorBlock: 100,
        });
        const storage = new SqliteBootstrapStorage();
        storage.insertSnapshotRows([
            {
                runId: 1,
                chainId: 1,
                collectionId,
                contract: CONTRACT,
                tokenId: "1",
                owner: OWNER,
                anchorBlock: 100,
            },
        ]);
        const input = prepareBootstrapSnapshotFixture({
            runId: 1,
            chainId: 1,
            collectionId,
            contract: CONTRACT,
            anchorBlock: 100,
            anchorHash: HASH,
            anchorTimestamp: 1200,
        });
        const rpc = { getBlock: vi.fn(async () => ANCHOR) };
        const installer = new InstallBootstrapOwnershipSnapshot(
            rpc,
            { captureSyncCheckpoint: captureChainSyncCheckpoint },
            storage,
        );
        return { collectionId, storage, input, rpc, installer };
    }

    function bases() {
        return db
            .prepare(
                "SELECT run_id,revision,anchor_block,anchor_hash FROM collection_ownership_bases",
            )
            .all();
    }

    it("selecting an anchor and preparing tasks grants no base or applied progress", () => {
        fixture();
        expect(bases()).toEqual([]);
        expect(
            db.prepare("SELECT * FROM collection_sync_progress").all(),
        ).toEqual([]);
        expect(db.prepare("SELECT * FROM blocks").all()).toEqual([]);
    });

    it("atomically installs ownership and its base without granting canonical readiness", async () => {
        const f = fixture();
        await f.installer.execute(f.input);
        expect(f.rpc.getBlock).toHaveBeenCalledWith(100, { fresh: true });
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: OWNER, amount: "1" },
        ]);
        expect(bases()).toEqual([
            { run_id: 1, revision: 0, anchor_block: 100, anchor_hash: HASH },
        ]);
        expect(
            db.prepare("SELECT * FROM collection_sync_progress").all(),
        ).toEqual([]);
        expect(db.prepare("SELECT * FROM blocks").all()).toEqual([]);
    });

    it("rejects a rollback that happens during final anchor verification", async () => {
        const f = fixture();
        f.rpc.getBlock.mockImplementation(async () => {
            advanceChainSyncRevision(1);
            return ANCHOR;
        });
        await expect(f.installer.execute(f.input)).rejects.toThrow(
            ChainSyncConflict,
        );
        expect(bases()).toEqual([]);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([]);
    });

    it("can install after an earlier harmless revision change when the exact anchor still exists", async () => {
        const f = fixture();
        advanceChainSyncRevision(1);
        await f.installer.execute(f.input);
        expect(bases()[0]).toMatchObject({ revision: 1 });
    });

    it("rebinds an installed but unaccepted base after fresh anchor verification", async () => {
        const f = fixture();
        await f.installer.execute(f.input);
        advanceChainSyncRevision(1);
        await f.installer.execute(f.input);
        expect(bases()[0]).toMatchObject({ revision: 1 });
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: OWNER, amount: "1" },
        ]);
    });

    it("rejects an anchor replaced before installation", async () => {
        const f = fixture();
        f.rpc.getBlock.mockResolvedValue({
            ...ANCHOR,
            hash: `0x${"ee".repeat(32)}`,
        });
        await expect(f.installer.execute(f.input)).rejects.toThrow(
            ChainSyncConflict,
        );
        expect(bases()).toEqual([]);
    });

    it("does not write a late old-anchor ownership response into a reseeded task", () => {
        const f = fixture();
        f.storage.insertOwnershipTasks([
            {
                runId: 1,
                chainId: 1,
                collectionId: f.collectionId,
                contract: CONTRACT,
                tokenId: "1",
                standard: COLLECTION_STANDARD.Erc721,
                anchorBlock: 101,
                anchorHash: `0x${"ff".repeat(32)}`,
                anchorTimestamp: 1212,
            },
        ]);
        const before = db.prepare("SELECT * FROM nft_balance_snapshots").all();
        expect(
            f.storage.markOwnershipTaskSucceeded({
                runId: 1,
                tokenId: "1",
                attempts: 1,
                owner: BUYER,
                block: { chainId: 1, blockNumber: 100, blockHash: HASH },
            }),
        ).toBe(false);
        expect(db.prepare("SELECT * FROM nft_balance_snapshots").all()).toEqual(
            before,
        );
        expect(f.storage.getOwnershipTaskCounts(1)).toMatchObject({
            pending: 1,
            succeeded: 0,
        });
    });

    it.each(["lease", "anchor", "run", "tasks"])(
        "rejects changed %s evidence before writing balances",
        async (kind) => {
            const f = fixture();
            f.rpc.getBlock.mockImplementation(async () => {
                if (kind === "lease")
                    db.prepare(
                        "UPDATE bootstrap_run_steps SET lease_owner='other' WHERE step_key=?",
                    ).run(BOOTSTRAP_STEP_KEY.Ownership);
                if (kind === "anchor")
                    db.prepare(
                        "UPDATE bootstrap_runs SET anchor_block_hash='replaced'",
                    ).run();
                if (kind === "run")
                    db.prepare(
                        "UPDATE bootstrap_runs SET collection_id=999",
                    ).run();
                if (kind === "tasks")
                    db.prepare(
                        "UPDATE bootstrap_ownership_snapshot_tasks SET status=?",
                    ).run(BOOTSTRAP_TASK_STATUS.Pending);
                return ANCHOR;
            });
            await expect(f.installer.execute(f.input)).rejects.toThrow(
                ChainSyncConflict,
            );
            expect(bases()).toEqual([]);
            expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([]);
        },
    );

    it("refuses to replace already applied collection progress without installed-base evidence", async () => {
        const f = fixture();
        db.prepare(
            "INSERT INTO collection_sync_progress(chain_id,collection_id,revision,anchor_block,anchor_hash,applied_block,applied_hash) VALUES (?,?,?,?,?,?,?)",
        ).run(1, f.collectionId, 0, 100, HASH, 101, "next");
        await expect(f.installer.execute(f.input)).rejects.toThrow(
            ChainSyncConflict,
        );
        expect(bases()).toEqual([]);
    });

    it("a duplicate install cannot erase post-anchor ownership after coordinator advancement", async () => {
        const f = fixture();
        await f.installer.execute(f.input);
        db.prepare(
            "INSERT INTO collection_sync_progress(chain_id,collection_id,revision,anchor_block,anchor_hash,applied_block,applied_hash) VALUES (?,?,?,?,?,?,?)",
        ).run(1, f.collectionId, 0, 100, HASH, 101, "next");
        db.prepare(
            "UPDATE nft_balances SET owner=?,last_block_number=101,last_block_hash='next'",
        ).run(BUYER);
        await f.installer.execute(f.input);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: BUYER, amount: "1" },
        ]);
    });

    it("does not install while a detected conflict gates chain recovery", async () => {
        const f = fixture();
        db.prepare(
            "INSERT INTO chain_sync_progress(chain_id,revision,anchor_block,anchor_hash,applied_block,applied_hash,disputed_from) VALUES (?,?,?,?,?,?,?)",
        ).run(1, 0, 90, "anchor", 110, "applied", 101);
        await expect(f.installer.execute(f.input)).rejects.toThrow(
            ChainSyncConflict,
        );
        expect(bases()).toEqual([]);
    });

    it("rolls back ownership if recording installed-base evidence fails", async () => {
        const f = fixture();
        db.exec(
            "CREATE TEMP TRIGGER reject_base_install BEFORE INSERT ON collection_ownership_bases BEGIN SELECT RAISE(ABORT,'base write rejected'); END",
        );
        try {
            await expect(f.installer.execute(f.input)).rejects.toThrow(
                "base write rejected",
            );
            expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([]);
            expect(bases()).toEqual([]);
        } finally {
            db.exec("DROP TRIGGER reject_base_install");
        }
    });
});
