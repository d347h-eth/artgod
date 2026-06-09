import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { SqliteTokenMetadataRepository } from "./sqlite-token-metadata-repository.js";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-trading-metadata-"));
    return join(dir, "metadata.db");
}

function seedMetadataTables(): void {
    db.exec(
        "CREATE TABLE collections (" +
            "chain_id INTEGER NOT NULL, " +
            "collection_id INTEGER NOT NULL, " +
            "slug TEXT NOT NULL, " +
            "opensea_slug TEXT, " +
            "PRIMARY KEY (chain_id, collection_id)" +
            ");",
    );
    db.exec(
        "CREATE TABLE attribute_keys (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "chain_id INTEGER NOT NULL, " +
            "collection_id INTEGER NOT NULL, " +
            "key TEXT NOT NULL" +
            ");",
    );
    db.exec(
        "CREATE TABLE attributes (" +
            "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
            "chain_id INTEGER NOT NULL, " +
            "collection_id INTEGER NOT NULL, " +
            "attribute_key_id INTEGER NOT NULL, " +
            "value TEXT NOT NULL" +
            ");",
    );
    db.exec(
        "CREATE TABLE token_attributes (" +
            "chain_id INTEGER NOT NULL, " +
            "collection_id INTEGER NOT NULL, " +
            "token_id TEXT NOT NULL, " +
            "attribute_id INTEGER NOT NULL" +
            ");",
    );

    db.prepare<[number, number, string, string | null]>(
        "INSERT INTO collections (chain_id, collection_id, slug, opensea_slug) VALUES (?, ?, ?, ?)",
    ).run(1, 100, "artgod-slug", "terraforms");
    insertTokenTrait("123", "Biome", "53");
    insertTokenTrait("123", "Chroma", "Flow");
}

function insertTokenTrait(tokenId: string, key: string, value: string): void {
    const keyId = Number(
        db
            .prepare<
                [number, number, string]
            >("INSERT INTO attribute_keys (chain_id, collection_id, key) VALUES (?, ?, ?)")
            .run(1, 100, key).lastInsertRowid,
    );
    const attributeId = Number(
        db
            .prepare<
                [number, number, number, string]
            >("INSERT INTO attributes (chain_id, collection_id, attribute_key_id, value) VALUES (?, ?, ?, ?)")
            .run(1, 100, keyId, value).lastInsertRowid,
    );
    db.prepare<[number, number, string, number]>(
        "INSERT INTO token_attributes (chain_id, collection_id, token_id, attribute_id) VALUES (?, ?, ?, ?)",
    ).run(1, 100, tokenId, attributeId);
}

describe("SqliteTokenMetadataRepository", () => {
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        seedMetadataTables();
    });

    it("reads metadata by OpenSea collection slug", async () => {
        const repository = new SqliteTokenMetadataRepository(1);

        const traits = await repository.getTraits("terraforms", "123");

        assert.deepEqual(traits, [
            { type: "Biome", value: "53" },
            { type: "Chroma", value: "Flow" },
        ]);
    });

    it("also reads metadata by ArtGod collection slug", async () => {
        const repository = new SqliteTokenMetadataRepository(1);

        const traits = await repository.getTraits("artgod-slug", "123");

        assert.deepEqual(traits, [
            { type: "Biome", value: "53" },
            { type: "Chroma", value: "Flow" },
        ]);
    });

    it("returns an empty trait list when the token has no normalized traits", async () => {
        const repository = new SqliteTokenMetadataRepository(1);

        const traits = await repository.getTraits("terraforms", "999");

        assert.deepEqual(traits, []);
    });
});
