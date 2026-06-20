import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { SqliteTokenImageCacheRecords } from "../src/infra/media/sqlite-token-image-cache-records.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("token image cache records", () => {
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
            ].join("\n"),
        );
    });

    it("skips cache upserts when source metadata disappeared", () => {
        const records = new SqliteTokenImageCacheRecords();
        seedTokenMetadata("ipfs://image");
        db.prepare(
            "DELETE FROM token_metadata " +
                "WHERE chain_id = 1 AND collection_id = 7 AND token_id = '1'",
        ).run();

        expect(
            records.upsertTokenImageCache({
                chainId: 1,
                collectionId: 7,
                tokenId: "1",
                sourceImageUrl: "ipfs://image",
                requestedMaxDimension: 512,
                cacheKey: "cache",
                contentType: "image/webp",
                sourceBytes: 100,
                cachedBytes: 40,
                width: 512,
                height: 512,
                relativePath: "1/7/1/cache.webp",
                publicPath: "/media/token-images/1/7/1/cache.webp",
            }),
        ).toBe(false);
        expect(countTokenImageCacheRows()).toBe(0);
    });

    it("stores cache rows only for the current source image", () => {
        const records = new SqliteTokenImageCacheRecords();
        seedTokenMetadata("ipfs://image-v2");

        expect(
            records.upsertTokenImageCache({
                chainId: 1,
                collectionId: 7,
                tokenId: "1",
                sourceImageUrl: "ipfs://image-v1",
                requestedMaxDimension: 512,
                cacheKey: "cache-v1",
                contentType: "image/webp",
                sourceBytes: 100,
                cachedBytes: 40,
                width: 512,
                height: 512,
                relativePath: "1/7/1/cache-v1.webp",
                publicPath: "/media/token-images/1/7/1/cache-v1.webp",
            }),
        ).toBe(false);
        expect(countTokenImageCacheRows()).toBe(0);

        expect(
            records.upsertTokenImageCache({
                chainId: 1,
                collectionId: 7,
                tokenId: "1",
                sourceImageUrl: "ipfs://image-v2",
                requestedMaxDimension: 512,
                cacheKey: "cache-v2",
                contentType: "image/webp",
                sourceBytes: 100,
                cachedBytes: 40,
                width: 512,
                height: 512,
                relativePath: "1/7/1/cache-v2.webp",
                publicPath: "/media/token-images/1/7/1/cache-v2.webp",
            }),
        ).toBe(true);
        expect(countTokenImageCacheRows()).toBe(1);
    });
});

function seedTokenMetadata(image: string): void {
    db.prepare(
        "INSERT INTO token_metadata " +
            "(chain_id, collection_id, contract_address, token_id, uri, image, attributes_json) " +
            "VALUES (1, 7, '0xabcd000000000000000000000000000000000000', '1', 'ipfs://metadata', ?, '[]')",
    ).run(image);
}

function countTokenImageCacheRows(): number {
    const row = db
        .prepare("SELECT COUNT(1) AS count FROM token_image_cache")
        .get() as { count: number } | undefined;
    return row?.count ?? 0;
}
