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
                "DELETE FROM token_attributes;",
                "DELETE FROM attributes;",
                "DELETE FROM attribute_keys;",
            ].join("\n"),
        );
    });

    it("recomputes per-attribute token counts for a collection", async () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";

        const colorRedId = seedAttribute(chainId, contract, "Color", "Red");
        const colorGreenId = seedAttribute(chainId, contract, "Color", "Green");
        const backgroundBlueId = seedAttribute(
            chainId,
            contract,
            "Background",
            "Blue",
        );

        seedTokenAttribute(chainId, contract, "1", colorRedId);
        seedTokenAttribute(chainId, contract, "1", backgroundBlueId);
        seedTokenAttribute(chainId, contract, "2", colorRedId);
        seedTokenAttribute(chainId, contract, "3", colorGreenId);

        const domain = new SqliteMetadataStatsDomain();
        await domain.handleRecompute({
            chainId,
            contract,
            reason: "metadata-sync",
        });

        const rows = db
            .prepare<{
                chainId: number;
                contractAddress: string;
            }>(
                "SELECT attributes.value as value, collection_trait_stats.token_count as token_count " +
                    "FROM collection_trait_stats " +
                    "JOIN attributes ON attributes.id = collection_trait_stats.attribute_id " +
                    "WHERE collection_trait_stats.chain_id = @chainId " +
                    "AND collection_trait_stats.contract_address = @contractAddress " +
                    "ORDER BY attributes.value",
            )
            .all({
                chainId,
                contractAddress: contract,
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
        const colorRedId = seedAttribute(chainId, contract, "Color", "Red");

        seedTokenAttribute(chainId, contract, "1", colorRedId);
        seedTokenAttribute(chainId, contract, "2", colorRedId);

        const domain = new SqliteMetadataStatsDomain();
        await domain.handleRecompute({
            chainId,
            contract,
            reason: "metadata-sync",
        });

        db.exec("DELETE FROM token_attributes;");
        seedTokenAttribute(chainId, contract, "1", colorRedId);

        await domain.handleRecompute({
            chainId,
            contract,
            reason: "metadata-refresh",
        });

        const row = db
            .prepare<{
                chainId: number;
                contractAddress: string;
            }>(
                "SELECT token_count FROM collection_trait_stats WHERE chain_id = @chainId AND contract_address = @contractAddress",
            )
            .get({
                chainId,
                contractAddress: contract,
            }) as { token_count: number } | undefined;

        expect(row?.token_count).toBe(1);
    });
});

function seedAttribute(
    chainId: number,
    contractAddress: string,
    key: string,
    value: string,
): number {
    db.prepare<{ chainId: number; contractAddress: string; key: string }>(
        "INSERT OR IGNORE INTO attribute_keys (chain_id, contract_address, key) VALUES (@chainId, @contractAddress, @key)",
    ).run({ chainId, contractAddress, key });

    const keyRow = db
        .prepare<{
            chainId: number;
            contractAddress: string;
            key: string;
        }>(
            "SELECT id FROM attribute_keys WHERE chain_id = @chainId AND contract_address = @contractAddress AND key = @key",
        )
        .get({ chainId, contractAddress, key }) as { id: number };

    db.prepare<{
        chainId: number;
        contractAddress: string;
        attributeKeyId: number;
        value: string;
    }>(
        "INSERT OR IGNORE INTO attributes (chain_id, contract_address, attribute_key_id, value) VALUES (@chainId, @contractAddress, @attributeKeyId, @value)",
    ).run({
        chainId,
        contractAddress,
        attributeKeyId: keyRow.id,
        value,
    });

    const attributeRow = db
        .prepare<{
            chainId: number;
            contractAddress: string;
            attributeKeyId: number;
            value: string;
        }>(
            "SELECT id FROM attributes WHERE chain_id = @chainId AND contract_address = @contractAddress AND attribute_key_id = @attributeKeyId AND value = @value",
        )
        .get({
            chainId,
            contractAddress,
            attributeKeyId: keyRow.id,
            value,
        }) as { id: number };

    return attributeRow.id;
}

function seedTokenAttribute(
    chainId: number,
    contractAddress: string,
    tokenId: string,
    attributeId: number,
): void {
    db.prepare<{
        chainId: number;
        contractAddress: string;
        tokenId: string;
        attributeId: number;
    }>(
        "INSERT OR IGNORE INTO token_attributes (chain_id, contract_address, token_id, attribute_id) VALUES (@chainId, @contractAddress, @tokenId, @attributeId)",
    ).run({
        chainId,
        contractAddress,
        tokenId,
        attributeId,
    });
}
