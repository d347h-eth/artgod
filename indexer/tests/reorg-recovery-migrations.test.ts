import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { MigrationRunner } from "@artgod/shared/migrations";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { SqliteCollectionPurgeRepository } from "../../backend/src/infra/collections/sqlite-collection-purge-repository.js";
import { SqliteSyncGapStore } from "../src/infra/storage/sqlite-sync-gaps.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
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
    pendingRecoveryJob,
} from "./helpers/reorg-recovery-fixture.js";

// Assert filename identity at the migration/storage boundary, including the two
// distinct 062 files. Upgrade may happen in either historical installation order.
const FEATURE_MIGRATIONS = new Set([
    "056_transfer_projection_order.sql",
    "057_collection_sync_gap_scans.sql",
    "062_chain_sync_ownership_checkpoints.sql",
    "063_chain_reorg_recoveries.sql",
]);
const MAIN_MIGRATION = "062_trait_competition_presets.sql";

describe("integrated reorg recovery migration upgrades", () => {
    loadTestEnv();
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
            expect(pendingRecoveryJob().payload).toMatchObject({
                fromBlock: 105,
                toBlock: 106,
            });
            new SqliteSyncGapStore().saveProgress(1, collectionId, {
                anchorBlock: F.Anchor,
                cursorBlock: null,
                pending: null,
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
