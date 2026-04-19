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
        "CREATE TABLE token_metadata (" +
            "chain_id INTEGER NOT NULL, " +
            "collection_id INTEGER NOT NULL, " +
            "token_id TEXT NOT NULL, " +
            "attributes_json TEXT, " +
            "PRIMARY KEY (chain_id, collection_id, token_id)" +
            ");",
    );

    db.prepare<
        [number, number, string, string | null]
    >(
        "INSERT INTO collections (chain_id, collection_id, slug, opensea_slug) VALUES (?, ?, ?, ?)",
    ).run(1, 100, "artgod-slug", "terraforms");
    db.prepare<[number, number, string, string | null]>(
        "INSERT INTO token_metadata (chain_id, collection_id, token_id, attributes_json) VALUES (?, ?, ?, ?)",
    ).run(
        1,
        100,
        "123",
        JSON.stringify([
            { traitType: "Biome", value: "53" },
            { traitType: "Chroma", value: "Flow" },
        ]),
    );
}

describe("SqliteTokenMetadataRepository", () => {
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        seedMetadataTables();
    });

    it("reads metadata by OpenSea collection slug", async () => {
        const repository = new SqliteTokenMetadataRepository(1);

        const metadata = await repository.getMetadata("terraforms", "123");

        assert.ok(metadata);
        assert.match(metadata ?? "", /Biome/);
    });

    it("also reads metadata by ArtGod collection slug", async () => {
        const repository = new SqliteTokenMetadataRepository(1);

        const metadata = await repository.getMetadata("artgod-slug", "123");

        assert.ok(metadata);
        assert.match(metadata ?? "", /Chroma/);
    });

    it("returns null when the token metadata row is missing", async () => {
        const repository = new SqliteTokenMetadataRepository(1);

        const metadata = await repository.getMetadata("terraforms", "999");

        assert.equal(metadata, null);
    });
});
