import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { DOMAIN_JOB_KIND } from "../src/domain/domain-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { eventSyncFollowUp } from "../src/domain/sync-follow-ups.js";
import { REORG_RECOVERY_PHASE } from "../src/domain/reorg-recovery.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    emptyOnChainData,
    insertCollection,
    transferFixture,
} from "./helpers/ownership-fixture.js";
import {
    FINALIZED_SYNC_CHECK_POLICY,
    syncBlockFixture,
} from "./helpers/chain-fixture.js";
import {
    canonicalRecoveryBlock,
    RecoveryRpc,
    reorgRecoveryServices,
    seedRecoveryHistory,
    REORG_FIXTURE as F,
} from "./helpers/reorg-recovery-fixture.js";

// Deliberately assert the migration-file boundary and its pre-upgrade storage.
const MIGRATION = "073_reconcile_legacy_block_headers.sql";

describe("legacy mixed-fork header cleanup", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        // This data-only migration has no schema changes. Removing its fixture
        // registration reconstructs the schema immediately before upgrade.
        db.prepare("DELETE FROM migrations WHERE name=?").run(MIGRATION);
    });

    function fixture(withTransfer = false) {
        const rpc = new RecoveryRpc();
        const services = reorgRecoveryServices(rpc);
        const f = withTransfer ? seedRecoveryHistory() : transferFixture();
        const collection = services.registry.getCollection(1, f.collectionId)!;
        const persist = (numbers: number[], canonical = false) =>
            services.storage.persistSyncResult({
                checkpoint: services.storage.captureSyncCheckpoint(1),
                canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
                collections: [collection],
                blocks: numbers.map((n) =>
                    canonical ? canonicalRecoveryBlock(n) : syncBlockFixture(n),
                ),
                data: emptyOnChainData(),
            });
        if (!withTransfer) persist([F.Anchor, F.Fork, F.Orphan]);
        persist([F.Orphan + 1], true);
        db.prepare("UPDATE blocks SET created_at=? WHERE chain_id=1").run(
            "2000-01-01 00:00:00",
        );
        return { ...services, ...f, collection, rpc, persist };
    }

    // A small fixture can compare every non-cleanup table, including data with
    // no block reference. This is stronger than checking only deletion counts.
    function retainedRows() {
        const mutable = new Set([
            "blocks",
            "collection_sync_blocks",
            "chain_sync_revisions",
            "migrations",
        ]);
        const tables = db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all() as { name: string }[];
        return Object.fromEntries(
            tables
                .filter(({ name }) => !mutable.has(name))
                .map(({ name }) => [
                    name,
                    db
                        .prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`)
                        .all(),
                ]),
        );
    }

    it("prunes only an unused broken header and its coverage, then refetches that height", async () => {
        const s = fixture();
        const otherCollection = insertCollection({
            chainId: 1,
            slug: "other-scope",
            address: F.Owner,
            anchorBlock: 100,
        });
        db.prepare(
            "INSERT INTO collection_sync_blocks(chain_id,collection_id,block_number) VALUES(1,?,?)",
        ).run(otherCollection, F.Orphan);
        const otherChainCollection = insertCollection({
            chainId: 2,
            slug: "other-chain",
            address: F.Owner,
            anchorBlock: 100,
        });
        s.storage.persistSyncResult({
            checkpoint: s.storage.captureSyncCheckpoint(2),
            canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
            collections: [s.registry.getCollection(2, otherChainCollection)!],
            blocks: [syncBlockFixture(F.Orphan)],
            data: emptyOnChainData(),
        });
        // Keep the second same-chain collection out of this acquisition test;
        // its coverage still has to be invalidated at the pruned identity.
        db.prepare("UPDATE collections SET status=? WHERE collection_id=?").run(
            COLLECTION_STATUS.Prepared,
            otherCollection,
        );
        const before = retainedRows();
        const checkpoint = s.storage.captureSyncCheckpoint(1);
        const otherCheckpoint = s.storage.captureSyncCheckpoint(2);
        const coverage = db
            .prepare(
                "SELECT * FROM collection_sync_blocks WHERE block_number<>? ORDER BY chain_id,collection_id,block_number",
            )
            .all(F.Orphan);

        await createMigrationRunner().runMigrations();
        expect(retainedRows()).toEqual(before);
        expect(s.storage.getBlockHash(1, F.Orphan)).toBeNull();
        expect(s.storage.getBlockHash(1, F.Fork)).toBe(
            syncBlockFixture(F.Fork).hash,
        );
        expect(s.storage.getBlockHash(2, F.Orphan)).toBe(
            syncBlockFixture(F.Orphan).hash,
        );
        expect(
            db
                .prepare(
                    "SELECT * FROM collection_sync_blocks WHERE block_number<>? ORDER BY chain_id,collection_id,block_number",
                )
                .all(F.Orphan),
        ).toEqual(coverage);
        expect(
            s.storage.countCollectionSyncedBlocksInRange(
                1,
                s.collectionId,
                F.Orphan,
                F.Orphan,
            ),
        ).toBe(0);
        expect(
            s.storage.countCollectionSyncedBlocksInRange(
                1,
                otherCollection,
                F.Orphan,
                F.Orphan,
            ),
        ).toBe(0);
        expect(
            s.storage.countCollectionSyncedBlocksInRange(
                2,
                otherChainCollection,
                F.Orphan,
                F.Orphan,
            ),
        ).toBe(1);
        expect(s.storage.captureSyncCheckpoint(1).revision).toBe(
            checkpoint.revision + 1,
        );
        expect(s.storage.captureSyncCheckpoint(2)).toEqual(otherCheckpoint);
        expect(() =>
            s.storage.persistSyncResult({
                checkpoint,
                canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
                collections: [s.collection],
                blocks: [canonicalRecoveryBlock(F.Orphan)],
                data: emptyOnChainData(),
            }),
        ).toThrow(ChainSyncConflict);

        const headers = vi.spyOn(s.rpc, "getBlock");
        expect(await s.executor.runDue()).toBe(true);
        expect(headers).toHaveBeenCalledWith(F.Orphan, { fresh: true });
        expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
            canonicalRecoveryBlock(F.Orphan).hash,
        );
        const after = s.storage.captureSyncCheckpoint(1);
        await createMigrationRunner().runMigrations();
        expect(s.storage.captureSyncCheckpoint(1)).toEqual(after);
    });

    it("retains fact-backed identities and ownership for verification without deleting any facts or coverage", async () => {
        const s = fixture(true);
        const before = retainedRows();
        const coverage = db
            .prepare(
                "SELECT * FROM collection_sync_blocks ORDER BY chain_id,collection_id,block_number",
            )
            .all();
        const checkpoint = s.storage.captureSyncCheckpoint(1);
        await createMigrationRunner().runMigrations();
        expect(retainedRows()).toEqual(before);
        expect(
            db
                .prepare(
                    "SELECT * FROM collection_sync_blocks ORDER BY chain_id,collection_id,block_number",
                )
                .all(),
        ).toEqual(coverage);
        expect(s.storage.captureSyncCheckpoint(1)).toEqual(checkpoint);
        expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
            syncBlockFixture(F.Orphan).hash,
        );
        expect(
            s.checks.nextDue({
                chainId: 1,
                now: Date.now(),
                upperBound: F.Head,
            }),
        ).toMatchObject({ blockNumber: F.Orphan });
        expect(
            db
                .prepare(
                    "SELECT canonical_check_pending FROM blocks WHERE chain_id=1 AND block_number=?",
                )
                .get(F.Orphan + 1),
        ).toEqual({ canonical_check_pending: 1 });
    });

    it.each([false, true])(
        "preserves retained event work (legacy JSON identity=%s)",
        async (legacy) => {
            const s = fixture();
            s.outbox.enqueueSyncFollowUp({
                revision: s.storage.captureSyncCheckpoint(1).revision,
                followUp: eventSyncFollowUp(
                    {
                        jobId: "header-dependent-event",
                        kind: DOMAIN_JOB_KIND.MetadataRefresh,
                        queue: QUEUE_NAMES.MetadataRefresh,
                        chainId: 1,
                        collectionId: s.collectionId,
                        payload: {},
                        scheduledAt: 0,
                        attempt: 0,
                    },
                    {
                        blockNumber: F.Orphan,
                        blockHash: syncBlockFixture(F.Orphan).hash,
                    },
                ),
            });
            if (legacy)
                db.exec(
                    "UPDATE queue_outbox SET sync_block_number=NULL,sync_block_hash=NULL",
                );
            const before = retainedRows();
            await createMigrationRunner().runMigrations();
            expect(retainedRows()).toEqual(before);
            expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
                syncBlockFixture(F.Orphan).hash,
            );
        },
    );

    it("preserves a bootstrap anchor even when it has no transfer facts", async () => {
        const s = fixture();
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=? WHERE collection_id=?",
        ).run(F.Orphan, s.collectionId);
        const before = retainedRows();
        await createMigrationRunner().runMigrations();
        expect(retainedRows()).toEqual(before);
        expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
            syncBlockFixture(F.Orphan).hash,
        );
    });

    it("keeps history before collection anchors outside automatic cleanup", async () => {
        const s = fixture();
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=? WHERE collection_id=?",
        ).run(F.Orphan + 1, s.collectionId);
        const headers = db
            .prepare("SELECT * FROM blocks ORDER BY chain_id,block_number")
            .all();
        const coverage = db
            .prepare(
                "SELECT * FROM collection_sync_blocks ORDER BY chain_id,collection_id,block_number",
            )
            .all();
        const before = retainedRows();
        await createMigrationRunner().runMigrations();
        expect(retainedRows()).toEqual(before);
        expect(
            db
                .prepare("SELECT * FROM blocks ORDER BY chain_id,block_number")
                .all(),
        ).toEqual(headers);
        expect(
            db
                .prepare(
                    "SELECT * FROM collection_sync_blocks ORDER BY chain_id,collection_id,block_number",
                )
                .all(),
        ).toEqual(coverage);
    });

    it("preserves ownership checkpoints without requiring retained transfer history", async () => {
        const s = fixture();
        db.prepare(
            "INSERT INTO erc721_ownership_checkpoints(chain_id,collection_id,contract_address,token_id,owner,block_number,block_hash,block_timestamp,bootstrap_anchor_block) VALUES(1,?,?,?,?,?,?,?,?)",
        ).run(
            s.collectionId,
            s.collection.address,
            "1",
            F.Owner,
            F.Orphan,
            syncBlockFixture(F.Orphan).hash,
            F.Orphan,
            F.Anchor,
        );
        const before = retainedRows();
        await createMigrationRunner().runMigrations();
        expect(retainedRows()).toEqual(before);
        expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
            syncBlockFixture(F.Orphan).hash,
        );
    });

    it("preserves sparse ancestor history and the journal of an active legacy recovery", async () => {
        const s = fixture();
        db.prepare(
            "INSERT INTO chain_reorg_recoveries(chain_id,recovery_id,version,revision,checked_block,stored_hash,observed_hash,phase,retry_at) VALUES(1,?,0,0,?,?,?, ?,?)",
        ).run(
            "legacy-recovery",
            F.Orphan,
            syncBlockFixture(F.Orphan).hash,
            canonicalRecoveryBlock(F.Orphan).hash,
            REORG_RECOVERY_PHASE.AwaitingAncestor,
            Date.now() + 100_000,
        );
        const before = retainedRows();
        await createMigrationRunner().runMigrations();
        expect(retainedRows()).toEqual(before);
        expect(s.storage.getBlockHash(1, F.Orphan)).toBe(
            syncBlockFixture(F.Orphan).hash,
        );
    });

    it.each([false, true])(
        "leaves post-upgrade headers or existing check backoff unchanged (pending=%s)",
        async (pending) => {
            const s = fixture();
            db.prepare(
                "UPDATE blocks SET created_at=?,canonical_check_pending=?,canonical_check_retry_at=? WHERE chain_id=1 AND block_number=?",
            ).run(
                pending ? "2000-01-01 00:00:00" : "2999-01-01 00:00:00",
                pending ? 1 : 0,
                pending ? Date.now() + 100_000 : 0,
                F.Orphan,
            );
            const before = db
                .prepare("SELECT * FROM blocks ORDER BY chain_id,block_number")
                .all();
            await createMigrationRunner().runMigrations();
            expect(
                db
                    .prepare(
                        "SELECT * FROM blocks ORDER BY chain_id,block_number",
                    )
                    .all(),
            ).toEqual(before);
        },
    );

    it("rolls back pruning, coverage invalidation, checks and revision together when cleanup fails", async () => {
        const s = fixture();
        const headers = db
            .prepare("SELECT * FROM blocks ORDER BY chain_id,block_number")
            .all();
        const coverage = db
            .prepare(
                "SELECT * FROM collection_sync_blocks ORDER BY chain_id,collection_id,block_number",
            )
            .all();
        const checkpoint = s.storage.captureSyncCheckpoint(1);
        const before = retainedRows();
        db.exec(
            "CREATE TEMP TRIGGER fail_header_cleanup BEFORE DELETE ON blocks BEGIN SELECT RAISE(ABORT,'header cleanup unavailable'); END;",
        );
        await expect(createMigrationRunner().runMigrations()).rejects.toThrow(
            "header cleanup unavailable",
        );
        expect(retainedRows()).toEqual(before);
        expect(
            db
                .prepare("SELECT * FROM blocks ORDER BY chain_id,block_number")
                .all(),
        ).toEqual(headers);
        expect(
            db
                .prepare(
                    "SELECT * FROM collection_sync_blocks ORDER BY chain_id,collection_id,block_number",
                )
                .all(),
        ).toEqual(coverage);
        expect(s.storage.captureSyncCheckpoint(1)).toEqual(checkpoint);
        expect(
            db
                .prepare("SELECT name FROM migrations WHERE name=?")
                .get(MIGRATION),
        ).toBeUndefined();
        db.exec("DROP TRIGGER fail_header_cleanup;");
        await createMigrationRunner().runMigrations();
        expect(s.storage.getBlockHash(1, F.Orphan)).toBeNull();
    });
});
