import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import {
    TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
    TOKEN_ATTRIBUTE_SOURCE_KIND,
} from "@artgod/shared/types/token-attributes";
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
                "DELETE FROM collections;",
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
        const collectionId = ensureCollection(chainId, contract);

        seedAttribute(chainId, collectionId, contract, "Biome", "81");
        seedAttribute(chainId, collectionId, contract, "Mode", "Terrain");
        linkToken(chainId, collectionId, contract, "1", [
            ["Biome", "81"],
            ["Mode", "Terrain"],
        ]);
        linkToken(chainId, collectionId, contract, "2", [
            ["Biome", "81"],
            ["Mode", "Terrain"],
        ]);
        linkToken(chainId, collectionId, contract, "3", [["Biome", "81"]]);

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
        const resolved = registry.ensureTokenSet({
            chainId,
            collectionId,
            schema,
        });
        expect(resolved).not.toBeNull();
        if (!resolved) return;

        const expectedRoot = generateMerkleRoot(["1", "2"]);
        expect(resolved.merkleRoot).toBe(expectedRoot);
        expect(resolved.tokenSetId).toBe(`list:${contract}:${expectedRoot}`);

        const row = db
            .prepare<{
                chainId: number;
                collectionId: number;
                tokenSetId: string;
            }>(
                "SELECT COUNT(1) as count FROM token_sets_tokens WHERE chain_id = @chainId AND collection_id = @collectionId AND token_set_id = @tokenSetId",
            )
            .get({
                chainId,
                collectionId,
                tokenSetId: resolved.tokenSetId,
            }) as {
            count: number;
        };
        expect(row.count).toBe(2);
    });

    it("resolves collection token sets from balances", () => {
        const chainId = 1;
        const contract = "0xdef0000000000000000000000000000000000000";
        const collectionId = ensureCollection(chainId, contract);
        seedBalance(chainId, collectionId, contract, "10");
        seedBalance(chainId, collectionId, contract, "11");
        seedBalance(chainId, collectionId, contract, "12");

        const registry = new SqliteTokenSetRegistry();
        const schema: TokenSetSchema = {
            kind: "collection",
            data: {
                collection: contract,
            },
        };
        const resolved = registry.ensureTokenSet({
            chainId,
            collectionId,
            schema,
        });
        expect(resolved).not.toBeNull();
        if (!resolved) return;

        const expectedRoot = generateMerkleRoot(["10", "11", "12"]);
        expect(resolved.merkleRoot).toBe(expectedRoot);
    });
});

function seedAttribute(
    chainId: number,
    collectionId: number,
    contractAddress: string,
    key: string,
    value: string,
): void {
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
}

function linkToken(
    chainId: number,
    collectionId: number,
    contractAddress: string,
    tokenId: string,
    pairs: Array<[string, string]>,
): void {
    db.prepare<[number, number, string, string]>(
        "INSERT OR IGNORE INTO tokens (chain_id, collection_id, contract_address, token_id) VALUES (?, ?, ?, ?)",
    ).run(chainId, collectionId, contractAddress, tokenId);

    for (const [key, value] of pairs) {
        const keyRow = db
            .prepare<{
                chainId: number;
                collectionId: number;
                key: string;
            }>(
                "SELECT id FROM attribute_keys WHERE chain_id = @chainId AND collection_id = @collectionId AND key = @key",
            )
            .get({
                chainId,
                collectionId,
                key,
            }) as { id: number };

        const attrRow = db
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

        db.prepare<[number, number, string, string, number, string, string]>(
            "INSERT OR IGNORE INTO token_attributes " +
                "(chain_id, collection_id, contract_address, token_id, attribute_id, source_kind, source_key) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
            chainId,
            collectionId,
            contractAddress,
            tokenId,
            attrRow.id,
            TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
            TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
        );
    }
}

function seedBalance(
    chainId: number,
    collectionId: number,
    contract: string,
    tokenId: string,
): void {
    db.prepare<
        [
            number,
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
            "(chain_id, collection_id, contract_address, token_id, owner, amount, last_block_number, last_block_hash, " +
            "last_block_timestamp, last_tx_hash, last_log_index) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        chainId,
        collectionId,
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
