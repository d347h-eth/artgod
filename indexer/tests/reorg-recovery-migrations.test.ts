import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { MigrationRunner } from "@artgod/shared/migrations";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { SqliteCollectionPurgeRepository } from "../../backend/src/infra/collections/sqlite-collection-purge-repository.js";
import { SqliteSyncGapStore } from "../src/infra/storage/sqlite-sync-gaps.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import {
    BACKFILL_SOURCE,
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    SYNC_JOB_KIND,
} from "../src/domain/sync-jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import {
    QUEUE_OUTBOX_RETRY_POLICY,
    QUEUE_OUTBOX_STATUS,
} from "../src/domain/queue-outbox.js";
import { REORG_RECOVERY_PHASE } from "../src/domain/reorg-recovery.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    insertCollection,
    emptyOnChainData,
    selectBalanceOwners,
} from "./helpers/ownership-fixture.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import {
    RecoveryRpc,
    reorgRecoveryServices,
    REORG_FIXTURE as F,
    pendingRecoveryRange,
} from "./helpers/reorg-recovery-fixture.js";

// Assert filename identity at the migration/storage boundary, including the two
// distinct 062 files. Upgrade may happen in either historical installation order.
const HEAD_CHECK_MIGRATION = "068_recent_gap_checks.sql";
const NEWEST_GAP_MIGRATION = "069_newest_gap_priority.sql";
const FEATURE_MIGRATIONS = new Set([
    "056_transfer_projection_order.sql",
    "057_collection_sync_gap_scans.sql",
    "062_chain_sync_ownership_checkpoints.sql",
    "063_chain_reorg_recoveries.sql",
    "064_required_sync_followups.sql",
    "065_direct_automatic_sync.sql",
    "066_sync_gap_due_paging.sql",
    "067_reset_collection_sale_coverage.sql",
    HEAD_CHECK_MIGRATION,
    NEWEST_GAP_MIGRATION,
]);
const MAIN_MIGRATION = "062_trait_competition_presets.sql";

describe("integrated reorg recovery migration upgrades", () => {
    loadTestEnv();
    it("upgrades pending automatic work from the merged schema without losing ranges or ordinary publications", async () => {
        const dbPath = await createTempDbPath();
        const migrationsDir = await mkdtemp(
            path.join(path.dirname(dbPath), "automatic-upgrade-"),
        );
        const source = resolveProjectPath("database/migrations");
        const filenames = (await readdir(source)).filter((file) =>
            file.endsWith(".sql"),
        );
        const additions = [
            "064_required_sync_followups.sql",
            "065_direct_automatic_sync.sql",
            "066_sync_gap_due_paging.sql",
            HEAD_CHECK_MIGRATION,
            NEWEST_GAP_MIGRATION,
        ];
        for (const file of filenames.filter(
            (file) => !additions.includes(file),
        ))
            await copyFile(
                path.join(source, file),
                path.join(migrationsDir, file),
            );
        setDbPath(dbPath);
        const runner = new MigrationRunner(migrationsDir);
        await runner.runMigrations();
        const collectionId = insertCollection({
            chainId: 1,
            slug: "pending-upgrade",
            address: F.Owner,
            anchorBlock: F.Anchor,
        });
        db.prepare(
            "INSERT INTO chain_sync_revisions (chain_id,revision) VALUES (1,1)",
        ).run();
        db.prepare(
            "INSERT INTO chain_reorg_recoveries (chain_id,recovery_id,version,revision,checked_block,stored_hash,observed_hash,phase,retry_at,range_from,range_to,target_block,delivery) VALUES (1,'old-recovery',9,1,105,'old','new',?,9999999999999,105,106,107,7)",
        ).run(REORG_RECOVERY_PHASE.Resync);
        // This fixture deliberately has the pre-upgrade schema; do not construct
        // today's adapter before its migrations have run.
        db.prepare(
            "INSERT INTO collection_sync_gap_scans(chain_id, collection_id, anchor_block, cursor_block, pending_job_id, pending_from_block, pending_to_block, retry_at) " +
                "VALUES(1, ?, ?, 103, 'old-gap', 105, 106, 9999999999999)",
        ).run(collectionId, F.Anchor);
        for (const source of [
            BACKFILL_SOURCE.ReorgRecovery,
            BACKFILL_SOURCE.ManualHistorical,
        ]) {
            const job = {
                jobId: `old:${source}`,
                kind: SYNC_JOB_KIND.BackfillRange,
                queue: QUEUE_NAMES.BackfillSync,
                chainId: 1,
                scheduledAt: 0,
                payload: {
                    fromBlock: 105,
                    toBlock: 106,
                    source,
                    orderMaintenancePolicy:
                        source === BACKFILL_SOURCE.ManualHistorical
                            ? BACKFILL_ORDER_MAINTENANCE_POLICY.SkipGlobalMakerRevalidation
                            : BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
                },
            };
            db.prepare(
                "INSERT INTO queue_outbox (queue_name,job_id,job_kind,job_json,chain_id,status) VALUES (?,?,?,?,1,?)",
            ).run(
                job.queue,
                job.jobId,
                job.kind,
                JSON.stringify(job),
                QUEUE_OUTBOX_STATUS.FailedTerminal,
            );
        }
        for (const file of additions)
            await copyFile(
                path.join(source, file),
                path.join(migrationsDir, file),
            );
        await runner.runMigrations();
        setDbPath(dbPath);
        await runner.runMigrations();
        const services = reorgRecoveryServices(new RecoveryRpc());
        expect(services.recoveries.getRecovery(1)).toMatchObject({
            recoveryId: "old-recovery",
            version: 9,
            revision: 1,
            fromBlock: 105,
            toBlock: 106,
            targetBlock: 107,
            retryAt: 0,
        });
        expect(services.gaps.getProgress(1, collectionId)).toMatchObject({
            cursorBlock: 103,
            pending: {
                repairId: "old-gap",
                fromBlock: 105,
                toBlock: 106,
                retryAt: 0,
            },
        });
        expect(
            (
                db.raw.pragma("table_info(chain_reorg_recoveries)") as {
                    name: string;
                }[]
            ).some((row) => row.name === "delivery"),
        ).toBe(false);
        expect(
            db.prepare("SELECT job_id, retry_policy FROM queue_outbox").all(),
        ).toEqual([
            {
                job_id: `old:${BACKFILL_SOURCE.ManualHistorical}`,
                retry_policy: QUEUE_OUTBOX_RETRY_POLICY.Bounded,
            },
        ]);
        await services.executor.runDue();
        expect(pendingRecoveryRange()).toMatchObject({
            fromBlock: 107,
            toBlock: 107,
        });
        expect(
            services.storage.countCollectionSyncedBlocksInRange(
                1,
                collectionId,
                105,
                106,
            ),
        ).toBe(2);
        expect(db.raw.pragma("foreign_key_check")).toEqual([]);
    });
    it.each(["main", "feature"])(
        "upgrades %s first, preserves data/workflow on reopen, and respects collection purge",
        async (first) => {
            const dbPath = await createTempDbPath();
            const migrationsDir = await mkdtemp(
                path.join(path.dirname(dbPath), "upgrade-migrations-"),
            );
            const source = resolveProjectPath("database/migrations");
            const filenames = (await readdir(source)).filter((file) =>
                file.endsWith(".sql"),
            );
            const initial = filenames.filter((file) =>
                first === "main"
                    ? !FEATURE_MIGRATIONS.has(file)
                    : file !== MAIN_MIGRATION,
            );
            for (const file of initial)
                await copyFile(
                    path.join(source, file),
                    path.join(migrationsDir, file),
                );
            setDbPath(dbPath);
            const runner = new MigrationRunner(migrationsDir);
            await runner.runMigrations();
            const contract = "0xabc0000000000000000000000000000000000000";
            const collectionId = insertCollection({
                chainId: 1,
                slug: "upgrade-recovery",
                address: contract,
                anchorBlock: F.Anchor,
            });
            db.prepare(
                "INSERT INTO nft_balances (chain_id, collection_id, contract_address, token_id, owner, amount, last_block_number, last_block_hash, last_block_timestamp, last_tx_hash, last_log_index) VALUES (?, ?, ?, '1', ?, '1', ?, ?, ?, ?, 0)",
            ).run(
                1,
                collectionId,
                contract,
                F.Owner,
                F.Anchor,
                syncBlockFixture(F.Anchor).hash,
                F.Anchor,
                syncBlockFixture(F.Anchor).hash,
            );
            async function beginRecovery() {
                const services = reorgRecoveryServices(new RecoveryRpc());
                const data = emptyOnChainData();
                data.collectionScoped.nftTransferEvents.push({
                    collectionId,
                    contract,
                    tokenId: "1",
                    from: F.Owner,
                    to: F.OrphanOwner,
                    amount: "1",
                    kind: COLLECTION_STANDARD.Erc721,
                    blockNumber: F.Orphan,
                    blockHash: syncBlockFixture(F.Orphan).hash,
                    txHash: syncBlockFixture(F.Orphan).hash,
                    logIndex: 1,
                });
                services.storage.persistSyncResult({
                    checkpoint: services.storage.captureSyncCheckpoint(1),
                    blocks: [
                        syncBlockFixture(F.Fork),
                        syncBlockFixture(F.Orphan),
                    ],
                    collections: [
                        services.registry.getCollection(1, collectionId)!,
                    ],
                    data,
                });
                await services.recovery.checkBlock(F.Orphan);
                return services;
            }
            // A feature-first installation may already have a committed rollback
            // and an unpublished continuation when it takes main's other 062 file.
            const retained =
                first === "feature"
                    ? (await beginRecovery()).recoveries.getRecovery(1)
                    : null;
            for (const file of filenames)
                if (!initial.includes(file))
                    await copyFile(
                        path.join(source, file),
                        path.join(migrationsDir, file),
                    );
            await runner.runMigrations();
            setDbPath(dbPath);
            await runner.runMigrations();
            const ledger = db
                .prepare("SELECT name FROM migrations ORDER BY name")
                .all() as Array<{ name: string }>;
            expect(ledger.map((row) => row.name)).toEqual(
                [...filenames].sort(),
            );
            expect(db.raw.pragma("foreign_key_check")).toEqual([]);
            expect(selectBalanceOwners(1, collectionId, "1")).toEqual([
                { owner: F.Owner, amount: "1" },
            ]);
            const services =
                first === "main"
                    ? await beginRecovery()
                    : reorgRecoveryServices(new RecoveryRpc());
            if (retained)
                expect(services.recoveries.getRecovery(1)).toEqual(retained);
            expect(services.storage.captureSyncCheckpoint(1).revision).toBe(1);
            expect(pendingRecoveryRange()).toMatchObject({
                fromBlock: 105,
                toBlock: 106,
            });
            const gapStore = new SqliteSyncGapStore();
            gapStore.saveProgress({
                chainId: 1,
                collectionId,
                expected: gapStore.getProgress(1, collectionId),
                progress: {
                    anchorBlock: F.Anchor,
                    cursorBlock: null,
                    pending: null,
                    lastHeadCheckAt: null,
                },
            });
            new SqliteCollectionPurgeRepository().purgeCollectionData({
                chainId: 1,
                collectionId,
            });
            expect(selectBalanceOwners(1, collectionId, "1")).toEqual([]);
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM erc721_ownership_checkpoints",
                    )
                    .get(),
            ).toEqual({ count: 0 });
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM collection_sync_gap_scans",
                    )
                    .get(),
            ).toEqual({ count: 0 });
            // Chain-wide recovery does not belong to the purged collection. Other
            // collections on this chain must keep its pending continuation.
            expect(services.recoveries.getRecovery(1)).not.toBeNull();
            expect(db.raw.pragma("foreign_key_check")).toEqual([]);
        },
    );
});
