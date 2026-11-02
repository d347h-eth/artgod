import { mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND } from "@artgod/shared/extensions";
import { COLLECTION_STANDARD, COLLECTION_STATUS } from "@artgod/shared/types";
import { SqliteSyncBackfillRepository } from "../infra/sync-backfill/sqlite-sync-backfill-repository.js";

export const BLOCKSPACE_FIXTURE_SLUG = "public-blockspace-fixture";
export const BLOCKSPACE_FIXTURE_DEPLOYMENT = 17;

export async function createBlockspaceFixture() {
    const root = fileURLToPath(
        new URL("../../../tmp/blockspace-tests/", import.meta.url),
    );
    await mkdir(root, { recursive: true });
    const path = join(await mkdtemp(join(root, "coverage-")), "main.sqlite");
    setDbPath(path);
    await createMigrationRunner().runMigrations();
    const seedCollection = () =>
        Number(
            db
                .prepare(
                    "INSERT INTO collections (chain_id, slug, address, standard, status, token_scope_kind, deployment_block, bootstrap_anchor_block) " +
                        "VALUES (1, ?, ?, ?, ?, ?, ?, 100)",
                )
                .run(
                    BLOCKSPACE_FIXTURE_SLUG,
                    "0x1111111111111111111111111111111111111111",
                    COLLECTION_STANDARD.Erc721,
                    COLLECTION_STATUS.Live,
                    EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
                    BLOCKSPACE_FIXTURE_DEPLOYMENT,
                ).lastInsertRowid,
        );
    const collectionId = seedCollection();
    const seedHead = (head: number) =>
        db
            .prepare(
                "INSERT OR IGNORE INTO blocks (chain_id, block_number, block_hash, parent_hash, timestamp) VALUES (1, ?, ?, ?, ?)",
            )
            .run(head, `0xblock${head}`, `0xparent${head}`, head * 12);
    const seedCoverage = (members: number[], id = collectionId) => {
        const insert = db.prepare(
            "INSERT OR IGNORE INTO collection_sync_blocks (chain_id, collection_id, block_number) VALUES (1, ?, ?)",
        );
        db.writeTransaction(() => {
            for (const block of members) insert.run(id, block);
        })();
    };
    const scope = { chainId: 1, collectionRef: BLOCKSPACE_FIXTURE_SLUG };
    const context = {
        kind: "collection" as const,
        collectionId,
        slug: BLOCKSPACE_FIXTURE_SLUG,
        deploymentBlock: BLOCKSPACE_FIXTURE_DEPLOYMENT,
        bootstrapAnchorBlock: 100,
    };
    return {
        path,
        collectionId,
        scope,
        context,
        seedCollection,
        seedHead,
        seedCoverage,
        repository: new SqliteSyncBackfillRepository(),
        close: () => {
            db.raw.close();
        },
    };
}
