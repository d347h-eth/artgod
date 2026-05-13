import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { SqliteCollectionSettingsRepository } from "./sqlite-collection-settings-repository.js";

async function createTempDbPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "artgod-collection-settings-"));
    return join(dir, "main.sqlite");
}

function seedCollection(): number {
    const result = db
        .prepare<{
            chainId: number;
            slug: string;
            address: string;
            standard: string;
            status: string;
            tokenScopeKind: string;
            openseaSlug: string;
        }>(
            "INSERT INTO collections " +
                "(chain_id, slug, address, standard, status, token_scope_kind, opensea_slug) " +
                "VALUES (@chainId, @slug, @address, @standard, @status, @tokenScopeKind, @openseaSlug)",
        )
        .run({
            chainId: 1,
            slug: "artgod-slug",
            address: "0x1111111111111111111111111111111111111111",
            standard: "erc721",
            status: "live",
            tokenScopeKind: "contract_all_tokens",
            openseaSlug: "terraforms",
        });

    return Number(result.lastInsertRowid);
}

describe("SqliteCollectionSettingsRepository", () => {
    let collectionId = 0;

    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        const migrationRunner = createMigrationRunner();
        await migrationRunner.runMigrations();
        collectionId = seedCollection();
    });

    it("persists and reloads generic collection-scoped settings", () => {
        const repository = new SqliteCollectionSettingsRepository();

        const missing = repository.getCollectionSetting({
            chainId: 1,
            collectionId,
            key: "test.setting",
        });
        assert.equal(missing, null);

        const updated = repository.upsertCollectionSetting({
            chainId: 1,
            collectionId,
            key: "test.setting",
            valueJson: JSON.stringify({ value: "on" }),
        });
        assert.equal(updated.key, "test.setting");
        assert.equal(updated.valueJson, JSON.stringify({ value: "on" }));

        const reloaded = repository.getCollectionSetting({
            chainId: 1,
            collectionId,
            key: "test.setting",
        });
        assert.equal(reloaded?.valueJson, JSON.stringify({ value: "on" }));
    });
});
