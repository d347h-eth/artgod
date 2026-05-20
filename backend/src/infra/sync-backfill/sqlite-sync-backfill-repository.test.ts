import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { SqliteSyncBackfillRepository } from "./sqlite-sync-backfill-repository.js";

type QueryPlanRow = {
    detail: string;
};

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-sync-backfill-"));
    return join(dir, "main.sqlite");
}

describe("SqliteSyncBackfillRepository", () => {
    let collectionId = 0;

    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        const migrationRunner = createMigrationRunner();
        await migrationRunner.runMigrations();
        collectionId = seedCollection();
    });

    it("counts any-chain coverage buckets with one indexed grouped range scan", () => {
        seedBlocks([0, 1, 2, 3, 7, 8]);
        const repository = new SqliteSyncBackfillRepository();

        const counts = repository.countSyncedBlocksByRange(1, { kind: "any" }, [
            { fromBlock: 0, toBlock: 3 },
            { fromBlock: 4, toBlock: 7 },
            { fromBlock: 8, toBlock: 11 },
            { fromBlock: 12, toBlock: 11 },
        ]);

        assert.deepEqual(
            counts.map((range) => range.syncedBlockCount),
            [4, 1, 1, 0],
        );
        assertPlanUsesIndex(
            "EXPLAIN QUERY PLAN " +
                "SELECT CAST((block_number - @fromBlock) / @bucketSize AS INTEGER) AS bucket_index, " +
                "COUNT(1) AS count FROM blocks " +
                "WHERE chain_id = @chainId AND block_number BETWEEN @fromBlock AND @toBlock " +
                "GROUP BY bucket_index",
            {
                chainId: 1,
                fromBlock: 0,
                toBlock: 11,
                bucketSize: 4,
            },
            "sqlite_autoindex_blocks_1",
        );
    });

    it("counts collection coverage buckets with one indexed grouped range scan", () => {
        seedBlocks([0, 1, 2, 3, 7, 8]);
        seedCollectionSyncBlocks(collectionId, [1, 7, 8]);
        const repository = new SqliteSyncBackfillRepository();

        const counts = repository.countSyncedBlocksByRange(
            1,
            {
                kind: "collection",
                collectionId,
                slug: "terraforms",
                deploymentBlock: null,
            },
            [
                { fromBlock: 0, toBlock: 3 },
                { fromBlock: 4, toBlock: 7 },
                { fromBlock: 8, toBlock: 11 },
            ],
        );

        assert.deepEqual(
            counts.map((range) => range.syncedBlockCount),
            [1, 1, 1],
        );
        assertPlanUsesIndex(
            "EXPLAIN QUERY PLAN " +
                "SELECT CAST((block_number - @fromBlock) / @bucketSize AS INTEGER) AS bucket_index, " +
                "COUNT(1) AS count FROM collection_sync_blocks " +
                "WHERE chain_id = @chainId AND collection_id = @collectionId " +
                "AND block_number BETWEEN @fromBlock AND @toBlock " +
                "GROUP BY bucket_index",
            {
                chainId: 1,
                collectionId,
                fromBlock: 0,
                toBlock: 11,
                bucketSize: 4,
            },
            "collection_sync_blocks_range_idx",
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
            bootstrapAnchorBlock: number;
        }>(
            "INSERT INTO collections " +
                "(chain_id, slug, address, standard, status, token_scope_kind, bootstrap_anchor_block) " +
                "VALUES (@chainId, @slug, @address, @standard, @status, @tokenScopeKind, @bootstrapAnchorBlock)",
        )
        .run({
            chainId: 1,
            slug: "terraforms",
            address: "0x1111111111111111111111111111111111111111",
            standard: "erc721",
            status: "live",
            tokenScopeKind: "contract_all_tokens",
            bootstrapAnchorBlock: 1,
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
        "INSERT INTO blocks (chain_id, block_number, block_hash, parent_hash, timestamp) " +
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
        "INSERT INTO collection_sync_blocks (chain_id, collection_id, block_number) " +
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

function assertPlanUsesIndex(
    sql: string,
    params: Record<string, number>,
    expectedIndex: string,
): void {
    const rows = db.prepare(sql).all(params) as QueryPlanRow[];
    const details = rows.map((row) => row.detail).join("\n");
    assert.match(details, new RegExp(`SEARCH .* USING .*${expectedIndex}`));
}
