import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { beforeEach, describe, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND } from "@artgod/shared/extensions";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STANDARD, COLLECTION_STATUS } from "@artgod/shared/types";
import { SqliteCollectionSettingsRepository } from "./sqlite-collection-settings-repository.js";

// Generic fixture collection identity kept distinct from first-launch presets.
const COLLECTION_SETTINGS_FIXTURE_SLUG = "collection-settings-fixture";
const COLLECTION_SETTINGS_FIXTURE_OPENSEA_SLUG =
    "collection-settings-fixture-opensea";

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
            slug: COLLECTION_SETTINGS_FIXTURE_SLUG,
            address: "0x1111111111111111111111111111111111111111",
            standard: COLLECTION_STANDARD.Erc721,
            status: COLLECTION_STATUS.Live,
            tokenScopeKind:
                EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
            openseaSlug: COLLECTION_SETTINGS_FIXTURE_OPENSEA_SLUG,
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
