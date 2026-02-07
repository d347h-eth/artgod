import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { SqliteTokenSetRegistry } from "../src/infra/token-sets/sqlite.js";
import {
    generateMerkleRoot,
    generateSchemaHash,
} from "../src/application/token-sets/utils.js";
import type { TokenSetSchema } from "../src/domain/token-sets.js";

describe("token set registry", () => {
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
                "DELETE FROM nft_balances;",
            ].join("\n"),
        );
    });

    it("generates stable schema hashes for attribute sets", () => {
        const schema: TokenSetSchema = {
            kind: "attribute",
            data: {
                collection: "0xabc",
                attributes: [
                    { key: "Mode", value: "Terrain" },
                    { key: "Biome", value: "81" },
                ],
            },
        };
        const reordered: TokenSetSchema = {
            kind: "attribute",
            data: {
                collection: "0xabc",
                attributes: [
                    { key: "Biome", value: "81" },
                    { key: "Mode", value: "Terrain" },
                    { key: "Biome", value: "81" },
                ],
            },
        };
        expect(generateSchemaHash(schema)).toBe(generateSchemaHash(reordered));
    });

    it("resolves multi-trait attribute token sets and persists membership", () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";

        seedAttribute(chainId, contract, "Biome", "81");
        seedAttribute(chainId, contract, "Mode", "Terrain");
        linkToken(chainId, contract, "1", [
            ["Biome", "81"],
            ["Mode", "Terrain"],
        ]);
        linkToken(chainId, contract, "2", [
            ["Biome", "81"],
            ["Mode", "Terrain"],
        ]);
        linkToken(chainId, contract, "3", [["Biome", "81"]]);

        const registry = new SqliteTokenSetRegistry();
        const schema: TokenSetSchema = {
            kind: "attribute",
            data: {
                collection: contract,
                attributes: [
                    { key: "Biome", value: "81" },
                    { key: "Mode", value: "Terrain" },
                ],
            },
        };
        const resolved = registry.ensureTokenSet({ chainId, schema });
        expect(resolved).not.toBeNull();
        if (!resolved) return;

        const expectedRoot = generateMerkleRoot(["1", "2"]);
        expect(resolved.merkleRoot).toBe(expectedRoot);
        expect(resolved.tokenSetId).toBe(`list:${contract}:${expectedRoot}`);

        const row = db
            .prepare<{
                chainId: number;
                tokenSetId: string;
            }>("SELECT COUNT(1) as count FROM token_sets_tokens WHERE chain_id = @chainId AND token_set_id = @tokenSetId")
            .get({ chainId, tokenSetId: resolved.tokenSetId }) as {
            count: number;
        };
        expect(row.count).toBe(2);
    });

    it("resolves collection token sets from balances", () => {
        const chainId = 1;
        const contract = "0xdef0000000000000000000000000000000000000";
        seedBalance(chainId, contract, "10");
        seedBalance(chainId, contract, "11");
        seedBalance(chainId, contract, "12");

        const registry = new SqliteTokenSetRegistry();
        const schema: TokenSetSchema = {
            kind: "collection",
            data: {
                collection: contract,
            },
        };
        const resolved = registry.ensureTokenSet({ chainId, schema });
        expect(resolved).not.toBeNull();
        if (!resolved) return;

        const expectedRoot = generateMerkleRoot(["10", "11", "12"]);
        expect(resolved.merkleRoot).toBe(expectedRoot);
    });
});

function seedAttribute(
    chainId: number,
    contractAddress: string,
    key: string,
    value: string,
): void {
    db.prepare<{ chainId: number; contractAddress: string; key: string }>(
        "INSERT OR IGNORE INTO attribute_keys (chain_id, contract_address, key) VALUES (@chainId, @contractAddress, @key)",
    ).run({ chainId, contractAddress, key });

    const keyRow = db
        .prepare<{
            chainId: number;
            contractAddress: string;
            key: string;
        }>("SELECT id FROM attribute_keys WHERE chain_id = @chainId AND contract_address = @contractAddress AND key = @key")
        .get({ chainId, contractAddress, key }) as { id: number };

    db.prepare<{
        chainId: number;
        contractAddress: string;
        attributeKeyId: number;
        value: string;
    }>(
        "INSERT OR IGNORE INTO attributes (chain_id, contract_address, attribute_key_id, value) VALUES (@chainId, @contractAddress, @attributeKeyId, @value)",
    ).run({ chainId, contractAddress, attributeKeyId: keyRow.id, value });
}

function linkToken(
    chainId: number,
    contractAddress: string,
    tokenId: string,
    pairs: Array<[string, string]>,
): void {
    db.prepare<[number, string, string]>(
        "INSERT OR IGNORE INTO tokens (chain_id, contract_address, token_id) VALUES (?, ?, ?)",
    ).run(chainId, contractAddress, tokenId);

    for (const [key, value] of pairs) {
        const keyRow = db
            .prepare<{
                chainId: number;
                contractAddress: string;
                key: string;
            }>("SELECT id FROM attribute_keys WHERE chain_id = @chainId AND contract_address = @contractAddress AND key = @key")
            .get({
                chainId,
                contractAddress,
                key,
            }) as { id: number };

        const attrRow = db
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

        db.prepare<[number, string, string, number]>(
            "INSERT OR IGNORE INTO token_attributes (chain_id, contract_address, token_id, attribute_id) VALUES (?, ?, ?, ?)",
        ).run(chainId, contractAddress, tokenId, attrRow.id);
    }
}

function seedBalance(chainId: number, contract: string, tokenId: string): void {
    db.prepare<
        [
            number,
            string,
            string,
            string,
            string,
            number,
            string,
            number,
            string,
            number,
        ]
    >(
        "INSERT OR REPLACE INTO nft_balances " +
            "(chain_id, contract_address, token_id, owner, amount, last_block_number, last_block_hash, " +
            "last_block_timestamp, last_tx_hash, last_log_index) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        chainId,
        contract,
        tokenId,
        "0xowner",
        "1",
        1,
        "0xhash",
        1,
        "0xtx",
        0,
    );
}
