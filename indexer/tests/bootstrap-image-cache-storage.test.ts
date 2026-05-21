import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("bootstrap image cache storage", () => {
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
                status: "pending",
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
});
