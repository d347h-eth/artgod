import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { SqliteMetadataStatsDomain } from "../src/infra/domain/metadata-stats.js";

describe("metadata trait stats recompute", () => {
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
                "DELETE FROM collection_trait_stats;",
                "DELETE FROM token_sets_tokens;",
                "DELETE FROM token_sets;",
                "DELETE FROM token_attributes;",
                "DELETE FROM attributes;",
                "DELETE FROM attribute_keys;",
                "DELETE FROM tokens;",
                "DELETE FROM collections;",
            ].join("\n"),
        );
    });

    it("recomputes per-attribute token counts for a collection", async () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const collectionId = ensureCollection(chainId, contract);

        const colorRedId = seedAttribute(
            chainId,
            collectionId,
            contract,
            "Color",
            "Red",
        );
        const colorGreenId = seedAttribute(
            chainId,
            collectionId,
            contract,
            "Color",
            "Green",
        );
        const backgroundBlueId = seedAttribute(
            chainId,
            collectionId,
            contract,
            "Background",
            "Blue",
        );

        seedTokenAttribute(chainId, collectionId, contract, "1", colorRedId);
        seedTokenAttribute(
            chainId,
            collectionId,
            contract,
            "1",
            backgroundBlueId,
        );
        seedTokenAttribute(chainId, collectionId, contract, "2", colorRedId);
        seedTokenAttribute(chainId, collectionId, contract, "3", colorGreenId);

        const domain = new SqliteMetadataStatsDomain();
        await domain.handleRecompute({
            chainId,
            collectionId,
            contract,
            reason: "metadata-sync",
        });

        const rows = db
            .prepare<{
                chainId: number;
                collectionId: number;
            }>(
                "SELECT attributes.value as value, collection_trait_stats.token_count as token_count " +
                    "FROM collection_trait_stats " +
                    "JOIN attributes ON attributes.id = collection_trait_stats.attribute_id " +
                    "WHERE collection_trait_stats.chain_id = @chainId " +
                    "AND collection_trait_stats.collection_id = @collectionId " +
                    "ORDER BY attributes.value",
            )
            .all({
                chainId,
                collectionId,
            }) as Array<{ value: string; token_count: number }>;

        expect(rows).toEqual([
            { value: "Blue", token_count: 1 },
            { value: "Green", token_count: 1 },
            { value: "Red", token_count: 2 },
        ]);
    });

    it("replaces stale stats rows on recompute", async () => {
        const chainId = 1;
        const contract = "0xdef0000000000000000000000000000000000000";
        const collectionId = ensureCollection(chainId, contract);
        const colorRedId = seedAttribute(
            chainId,
            collectionId,
            contract,
            "Color",
            "Red",
        );

        seedTokenAttribute(chainId, collectionId, contract, "1", colorRedId);
        seedTokenAttribute(chainId, collectionId, contract, "2", colorRedId);

        const domain = new SqliteMetadataStatsDomain();
        await domain.handleRecompute({
            chainId,
            collectionId,
            contract,
            reason: "metadata-sync",
        });

        db.exec("DELETE FROM token_attributes;");
        seedTokenAttribute(chainId, collectionId, contract, "1", colorRedId);

        await domain.handleRecompute({
            chainId,
            collectionId,
            contract,
            reason: "metadata-refresh",
        });

        const row = db
            .prepare<{
                chainId: number;
                collectionId: number;
            }>(
                "SELECT token_count FROM collection_trait_stats WHERE chain_id = @chainId AND collection_id = @collectionId",
            )
            .get({
                chainId,
                collectionId,
            }) as { token_count: number } | undefined;

        expect(row?.token_count).toBe(1);
    });
});

function seedAttribute(
    chainId: number,
    collectionId: number,
    contractAddress: string,
    key: string,
    value: string,
): number {
    db.prepare<{
        chainId: number;
        collectionId: number;
        contractAddress: string;
        key: string;
    }>(
        "INSERT OR IGNORE INTO attribute_keys (chain_id, collection_id, contract_address, key) VALUES (@chainId, @collectionId, @contractAddress, @key)",
    ).run({ chainId, collectionId, contractAddress, key });

    const keyRow = db
        .prepare<{
            chainId: number;
            collectionId: number;
            key: string;
        }>(
            "SELECT id FROM attribute_keys WHERE chain_id = @chainId AND collection_id = @collectionId AND key = @key",
        )
        .get({ chainId, collectionId, key }) as { id: number };

    db.prepare<{
        chainId: number;
        collectionId: number;
        contractAddress: string;
        attributeKeyId: number;
        value: string;
    }>(
        "INSERT OR IGNORE INTO attributes (chain_id, collection_id, contract_address, attribute_key_id, value) VALUES (@chainId, @collectionId, @contractAddress, @attributeKeyId, @value)",
    ).run({
        chainId,
        collectionId,
        contractAddress,
        attributeKeyId: keyRow.id,
        value,
    });

    const attributeRow = db
        .prepare<{
            chainId: number;
            collectionId: number;
            attributeKeyId: number;
            value: string;
        }>(
            "SELECT id FROM attributes WHERE chain_id = @chainId AND collection_id = @collectionId AND attribute_key_id = @attributeKeyId AND value = @value",
        )
        .get({
            chainId,
            collectionId,
            attributeKeyId: keyRow.id,
            value,
        }) as { id: number };

    return attributeRow.id;
}

function seedTokenAttribute(
    chainId: number,
    collectionId: number,
    contractAddress: string,
    tokenId: string,
    attributeId: number,
): void {
    db.prepare<{
        chainId: number;
        collectionId: number;
        contractAddress: string;
        tokenId: string;
    }>(
        "INSERT OR IGNORE INTO tokens (chain_id, collection_id, contract_address, token_id) VALUES (@chainId, @collectionId, @contractAddress, @tokenId)",
    ).run({ chainId, collectionId, contractAddress, tokenId });

    db.prepare<{
        chainId: number;
        collectionId: number;
        contractAddress: string;
        tokenId: string;
        attributeId: number;
    }>(
        "INSERT OR IGNORE INTO token_attributes (chain_id, collection_id, contract_address, token_id, attribute_id) VALUES (@chainId, @collectionId, @contractAddress, @tokenId, @attributeId)",
    ).run({
        chainId,
        collectionId,
        contractAddress,
        tokenId,
        attributeId,
    });
}

function ensureCollection(chainId: number, contractAddress: string): number {
    const existing = db
        .prepare<
            [number, string]
        >("SELECT collection_id FROM collections WHERE chain_id = ? AND lower(address) = ? LIMIT 1")
        .get(chainId, contractAddress.toLowerCase()) as
        | { collection_id: number }
        | undefined;
    if (existing) {
        return existing.collection_id;
    }

    const inserted = db
        .prepare<
            [number, string, string]
        >("INSERT INTO collections " + "(chain_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply) " + "VALUES (?, ?, ?, 'erc721', 'live', 'contract_all_tokens', NULL, NULL)")
        .run(
            chainId,
            `fixture-${contractAddress.slice(2, 10).toLowerCase()}`,
            contractAddress.toLowerCase(),
        );
    return Number(inserted.lastInsertRowid);
}
