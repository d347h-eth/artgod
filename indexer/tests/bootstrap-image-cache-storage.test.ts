import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { BOOTSTRAP_TASK_STATUS } from "@artgod/shared/bootstrap/pipeline";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("bootstrap storage", () => {
    loadTestEnv();

    beforeAll(async () => {
        const dbPath = await createTempDbPath();
        setDbPath(dbPath);
        const migrations = createMigrationRunner();
        await migrations.runMigrations();
    });

    beforeEach(() => {
        db.exec(
            [
                "DELETE FROM token_image_cache;",
                "DELETE FROM token_metadata;",
                "DELETE FROM bootstrap_metadata_snapshot_tasks;",
                "DELETE FROM bootstrap_ownership_snapshot_tasks;",
                "DELETE FROM nft_balance_snapshots;",
            ].join("\n"),
        );
    });

    it("seeds image cache tasks from successful metadata tasks", () => {
        const storage = new SqliteBootstrapStorage();
        storage.insertMetadataTasks([
            {
                runId: 42,
                chainId: 1,
                collectionId: 7,
                contract: "0xAbCd000000000000000000000000000000000000",
                tokenId: "5081",
                standard: "erc721",
                anchorBlock: 100,
                anchorHash: `0x${"11".repeat(32)}`,
                anchorTimestamp: 1_726_000_000,
            },
        ]);
        storage.markMetadataTaskSucceeded(42, "5081", 1);
        db.prepare(
            "INSERT INTO token_metadata " +
                "(chain_id, collection_id, contract_address, token_id, uri, image, attributes_json) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
            1,
            7,
            "0xabcd000000000000000000000000000000000000",
            "5081",
            "ipfs://metadata",
            "ipfs://image",
            "[]",
        );

        expect(
            storage.seedImageCacheTasks({
                runId: 42,
                requestedMaxDimension: 512,
            }),
        ).toBe(1);

        const due = storage.listImageCacheTasksDueNow(42, Date.now(), 10);
        expect(due).toEqual([
            expect.objectContaining({
                runId: 42,
                chainId: 1,
                collectionId: 7,
                contract: "0xabcd000000000000000000000000000000000000",
                tokenId: "5081",
                sourceImageUrl: "ipfs://image",
                requestedMaxDimension: 512,
                status: BOOTSTRAP_TASK_STATUS.Pending,
            }),
        ]);
        expect(storage.getImageCacheTaskCounts(42)).toEqual({
            pending: 1,
            retry: 0,
            succeeded: 0,
            failedTerminal: 0,
            total: 1,
        });

        storage.markImageCacheTaskSucceeded({
            runId: 42,
            tokenId: "5081",
            attempts: 1,
            cacheKey: "cache",
            contentType: "image/webp",
            sourceBytes: 100,
            cachedBytes: 40,
            width: 512,
            height: 512,
            relativePath: "1/7/5081/cache.webp",
            publicPath: "/media/token-images/1/7/5081/cache.webp",
        });

        expect(storage.getImageCacheTaskCounts(42)).toEqual({
            pending: 0,
            retry: 0,
            succeeded: 1,
            failedTerminal: 0,
            total: 1,
        });
    });

    it("tracks ownership task retries and writes idempotent snapshot rows", () => {
        const storage = new SqliteBootstrapStorage();
        storage.insertOwnershipTasks([
            {
                runId: 77,
                chainId: 1,
                collectionId: 9,
                contract: "0xAbCd000000000000000000000000000000000000",
                tokenId: "1074",
                standard: "erc721",
                anchorBlock: 200,
                anchorHash: `0x${"22".repeat(32)}`,
                anchorTimestamp: 1_726_000_123,
            },
        ]);

        expect(storage.listOwnershipTasksDueNow(77, Date.now(), 10)).toEqual([
            expect.objectContaining({
                runId: 77,
                chainId: 1,
                collectionId: 9,
                contract: "0xabcd000000000000000000000000000000000000",
                tokenId: "1074",
                status: BOOTSTRAP_TASK_STATUS.Pending,
            }),
        ]);

        storage.markOwnershipTaskRetry({
            runId: 77,
            tokenId: "1074",
            attempts: 1,
            nextAttemptAt: 0,
            lastError: "temporary rpc failure",
            failedTerminal: false,
        });
        expect(storage.getOwnershipTaskCounts(77)).toEqual({
            pending: 0,
            retry: 1,
            succeeded: 0,
            failedTerminal: 0,
            total: 1,
        });

        storage.markOwnershipTaskSucceeded({
            runId: 77,
            tokenId: "1074",
            attempts: 2,
            owner: "0x1111111111111111111111111111111111111111",
        });
        storage.markOwnershipTaskSucceeded({
            runId: 77,
            tokenId: "1074",
            attempts: 3,
            owner: "0x2222222222222222222222222222222222222222",
        });

        expect(storage.getOwnershipTaskCounts(77)).toEqual({
            pending: 0,
            retry: 0,
            succeeded: 1,
            failedTerminal: 0,
            total: 1,
        });
        const rows = db
            .prepare<[number, string]>(
                "SELECT owner FROM nft_balance_snapshots WHERE run_id = ? AND token_id = ?",
            )
            .all(77, "1074") as Array<{ owner: string }>;
        expect(rows).toEqual([
            { owner: "0x2222222222222222222222222222222222222222" },
        ]);
    });
});
