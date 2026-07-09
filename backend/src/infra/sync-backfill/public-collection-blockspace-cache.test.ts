import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND } from "@artgod/shared/extensions";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STANDARD, COLLECTION_STATUS } from "@artgod/shared/types";
import {
    getCurrentQueryCacheDebugInfo,
    QUERY_CACHE_DEBUG_STATUSES,
    runWithQueryCacheDebugContext,
} from "../../utils/query-cache-debug.js";
import { PublicCollectionBlockspaceCache } from "./public-collection-blockspace-cache.js";
import { SqliteSyncBackfillRepository } from "./sqlite-sync-backfill-repository.js";

// Public blockspace cache tests use a local collection, not the preset row.
const PUBLIC_BLOCKSPACE_FIXTURE_SLUG = "public-blockspace-fixture";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-public-blockspace-"));
    return join(dir, "main.sqlite");
}

describe("PublicCollectionBlockspaceCache", () => {
    let collectionId = 0;
    let cache: PublicCollectionBlockspaceCache;

    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        const migrationRunner = createMigrationRunner();
        await migrationRunner.runMigrations();
        collectionId = seedCollection();
        seedBlocks([0, 1, 10, 11, 12, 20, 21, 22, 25, 30]);
        seedCollectionSyncBlocks(collectionId, [10, 11, 12, 20, 21, 25]);
        cache = new PublicCollectionBlockspaceCache(
            new SqliteSyncBackfillRepository(),
            {
                chainId: 1,
                collectionRef: PUBLIC_BLOCKSPACE_FIXTURE_SLUG,
                refreshMs: 5_000,
            },
        );
        cache.start();
    });

    afterEach(() => {
        cache.stop();
    });

    it("answers collection coverage from compact refreshed state", () => {
        const context = collectionContext(collectionId);

        runWithQueryCacheDebugContext(() => {
            assert.equal(cache.countSyncedBlocks(1, context), 6);
            assert.equal(
                getCurrentQueryCacheDebugInfo().status,
                QUERY_CACHE_DEBUG_STATUSES.Hit,
            );
        });
        assert.equal(
            cache.countSyncedBlocksInRange(1, context, {
                fromBlock: 0,
                toBlock: 9,
            }),
            0,
        );
        assert.equal(
            cache.countSyncedBlocksInRange(1, context, {
                fromBlock: 10,
                toBlock: 21,
            }),
            5,
        );
        assert.deepEqual(
            cache
                .countSyncedBlocksByRange(1, context, [
                    { fromBlock: 10, toBlock: 12 },
                    { fromBlock: 13, toBlock: 19 },
                    { fromBlock: 20, toBlock: 26 },
                ])
                .map((range) => range.syncedBlockCount),
            [3, 0, 3],
        );
    });

    it("uses full refresh as the mutation path for ongoing sync and backfill", () => {
        const context = collectionContext(collectionId);
        assert.equal(
            cache.countSyncedBlocksInRange(1, context, {
                fromBlock: 20,
                toBlock: 22,
            }),
            2,
        );

        seedCollectionSyncBlocks(collectionId, [22]);
        assert.equal(
            cache.countSyncedBlocksInRange(1, context, {
                fromBlock: 20,
                toBlock: 22,
            }),
            2,
        );

        cache.refreshNow();
        assert.equal(
            cache.countSyncedBlocksInRange(1, context, {
                fromBlock: 20,
                toBlock: 22,
            }),
            3,
        );
    });
});

function seedCollection(): number {
    const result = db
        .prepare<{
            chainId: number;
            slug: string;
            address: string;
            standard: string;
            status: string;
            tokenScopeKind: string;
            deploymentBlock: number;
            bootstrapAnchorBlock: number;
        }>(
            "INSERT INTO collections " +
                "(chain_id, slug, address, standard, status, token_scope_kind, deployment_block, bootstrap_anchor_block) " +
                "VALUES (@chainId, @slug, @address, @standard, @status, @tokenScopeKind, @deploymentBlock, @bootstrapAnchorBlock)",
        )
        .run({
            chainId: 1,
            slug: PUBLIC_BLOCKSPACE_FIXTURE_SLUG,
            address: "0x1111111111111111111111111111111111111111",
            standard: COLLECTION_STANDARD.Erc721,
            status: COLLECTION_STATUS.Live,
            tokenScopeKind:
                EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
            deploymentBlock: 10,
            bootstrapAnchorBlock: 10,
        });
    return Number(result.lastInsertRowid);
}

function seedBlocks(blockNumbers: number[]): void {
    const statement = db.prepare<{
        chainId: number;
        blockNumber: number;
        blockHash: string;
        parentHash: string;
        timestamp: number;
    }>(
        "INSERT OR IGNORE INTO blocks (chain_id, block_number, block_hash, parent_hash, timestamp) " +
            "VALUES (@chainId, @blockNumber, @blockHash, @parentHash, @timestamp)",
    );
    for (const blockNumber of blockNumbers) {
        statement.run({
            chainId: 1,
            blockNumber,
            blockHash: `0xblock${blockNumber}`,
            parentHash: `0xparent${blockNumber}`,
            timestamp: blockNumber * 12,
        });
    }
}

function seedCollectionSyncBlocks(
    seededCollectionId: number,
    blockNumbers: number[],
): void {
    const statement = db.prepare<{
        chainId: number;
        collectionId: number;
        blockNumber: number;
    }>(
        "INSERT OR IGNORE INTO collection_sync_blocks (chain_id, collection_id, block_number) " +
            "VALUES (@chainId, @collectionId, @blockNumber)",
    );
    for (const blockNumber of blockNumbers) {
        statement.run({
            chainId: 1,
            collectionId: seededCollectionId,
            blockNumber,
        });
    }
}

function collectionContext(collectionId: number) {
    return {
        kind: "collection" as const,
        collectionId,
        slug: PUBLIC_BLOCKSPACE_FIXTURE_SLUG,
        deploymentBlock: 10,
    };
}
