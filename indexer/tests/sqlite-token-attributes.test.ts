import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import {
    TERRAFORMS_EXTENSION_KEY,
    TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
    TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
    TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES,
} from "@artgod/shared/extensions/terraforms";
import {
    TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
    TOKEN_ATTRIBUTE_SOURCE_KIND,
} from "@artgod/shared/types/token-attributes";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    COLLECTION_STANDARD,
    CollectionTokenScope,
} from "../src/domain/collections.js";
import { SqliteTokenAttributeWriter } from "../src/infra/attributes/sqlite-token-attributes.js";

const CHAIN_ID = 1;
const COLLECTION_ID = 1;
const COLLECTION_SLUG = "test-collection";
const TOKEN_ID = "1";
const CONTRACT_ADDRESS = "0xabc0000000000000000000000000000000000000";

const TEST_TRAIT_KEYS = {
    Mode: "Mode",
    Rank: "Rank",
    Community: "Community",
} as const;

// Distinguishes a second collection-extension-owned trait source in writer tests.
const TEST_SECOND_EXTENSION_KEY = "test-secondary-extension";

type TokenAttributeLinkRow = {
    source_kind: string;
    source_key: string;
    key: string;
    value: string;
};

describe("sqlite token attribute writer", () => {
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
        seedCollectionToken();
    });

    it("replaces only one source while preserving other source links", () => {
        const writer = new SqliteTokenAttributeWriter();

        writer.replaceTokenAttributes({
            chainId: CHAIN_ID,
            collectionId: COLLECTION_ID,
            contractAddress: CONTRACT_ADDRESS,
            tokenId: TOKEN_ID,
            sourceKind: TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
            sourceKey: TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
            attributes: [
                { key: TEST_TRAIT_KEYS.Mode, value: "Terrain" },
                { key: TEST_TRAIT_KEYS.Rank, value: "7" },
            ],
        });
        writer.replaceTokenAttributes({
            chainId: CHAIN_ID,
            collectionId: COLLECTION_ID,
            contractAddress: CONTRACT_ADDRESS,
            tokenId: TOKEN_ID,
            sourceKind: TOKEN_ATTRIBUTE_SOURCE_KIND.CollectionExtension,
            sourceKey: TERRAFORMS_EXTENSION_KEY,
            attributes: [
                { key: TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY, value: "9964" },
                {
                    key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
                    value: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.YSeed,
                },
            ],
        });
        writer.replaceTokenAttributes({
            chainId: CHAIN_ID,
            collectionId: COLLECTION_ID,
            contractAddress: CONTRACT_ADDRESS,
            tokenId: TOKEN_ID,
            sourceKind: TOKEN_ATTRIBUTE_SOURCE_KIND.CollectionExtension,
            sourceKey: TEST_SECOND_EXTENSION_KEY,
            attributes: [
                { key: TEST_TRAIT_KEYS.Community, value: "Full Set" },
            ],
        });

        writer.replaceTokenAttributes({
            chainId: CHAIN_ID,
            collectionId: COLLECTION_ID,
            contractAddress: CONTRACT_ADDRESS,
            tokenId: TOKEN_ID,
            sourceKind: TOKEN_ATTRIBUTE_SOURCE_KIND.CollectionExtension,
            sourceKey: TERRAFORMS_EXTENSION_KEY,
            attributes: [
                { key: " Seed ", value: " 9297 " },
                { key: TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY, value: "9297" },
                { key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY, value: "" },
                { key: "", value: "ignored" },
            ],
        });

        expect(selectTokenAttributeLinks()).toEqual([
            {
                source_kind: TOKEN_ATTRIBUTE_SOURCE_KIND.CollectionExtension,
                source_key: TERRAFORMS_EXTENSION_KEY,
                key: TERRAFORMS_RENDERER_SEED_ATTRIBUTE_KEY,
                value: "9297",
            },
            {
                source_kind: TOKEN_ATTRIBUTE_SOURCE_KIND.CollectionExtension,
                source_key: TEST_SECOND_EXTENSION_KEY,
                key: TEST_TRAIT_KEYS.Community,
                value: "Full Set",
            },
            {
                source_kind: TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
                source_key: TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
                key: TEST_TRAIT_KEYS.Mode,
                value: "Terrain",
            },
            {
                source_kind: TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
                source_key: TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
                key: TEST_TRAIT_KEYS.Rank,
                value: "7",
            },
        ]);

        writer.replaceTokenAttributes({
            chainId: CHAIN_ID,
            collectionId: COLLECTION_ID,
            contractAddress: CONTRACT_ADDRESS,
            tokenId: TOKEN_ID,
            sourceKind: TOKEN_ATTRIBUTE_SOURCE_KIND.CollectionExtension,
            sourceKey: TERRAFORMS_EXTENSION_KEY,
            attributes: [],
        });

        expect(selectTokenAttributeLinks()).toEqual([
            {
                source_kind: TOKEN_ATTRIBUTE_SOURCE_KIND.CollectionExtension,
                source_key: TEST_SECOND_EXTENSION_KEY,
                key: TEST_TRAIT_KEYS.Community,
                value: "Full Set",
            },
            {
                source_kind: TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
                source_key: TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
                key: TEST_TRAIT_KEYS.Mode,
                value: "Terrain",
            },
            {
                source_kind: TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
                source_key: TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
                key: TEST_TRAIT_KEYS.Rank,
                value: "7",
            },
        ]);
    });
});

function seedCollectionToken(): void {
    const scope = CollectionTokenScope.allContractTokens().toPersistence();
    db.prepare<{
        chainId: number;
        collectionId: number;
        slug: string;
        address: string;
        standard: string;
        status: string;
        tokenScopeKind: string;
        scopeStartTokenId: string | null;
        scopeTotalSupply: number | null;
    }>(
        "INSERT INTO collections " +
            "(chain_id, collection_id, slug, address, standard, status, token_scope_kind, scope_start_token_id, scope_total_supply) " +
            "VALUES (@chainId, @collectionId, @slug, @address, @standard, @status, @tokenScopeKind, @scopeStartTokenId, @scopeTotalSupply)",
    ).run({
        chainId: CHAIN_ID,
        collectionId: COLLECTION_ID,
        slug: COLLECTION_SLUG,
        address: CONTRACT_ADDRESS,
        standard: COLLECTION_STANDARD.Erc721,
        status: COLLECTION_STATUS.Live,
        tokenScopeKind: scope.tokenScopeKind,
        scopeStartTokenId: scope.scopeStartTokenId,
        scopeTotalSupply: scope.scopeTotalSupply,
    });

    db.prepare<[number, number, string, string]>(
        "INSERT INTO tokens (chain_id, collection_id, contract_address, token_id) VALUES (?, ?, ?, ?)",
    ).run(CHAIN_ID, COLLECTION_ID, CONTRACT_ADDRESS, TOKEN_ID);
}

function selectTokenAttributeLinks(): TokenAttributeLinkRow[] {
    return db
        .prepare<[number, number, string]>(
            "SELECT ta.source_kind AS source_kind, ta.source_key AS source_key, ak.key AS key, a.value AS value " +
                "FROM token_attributes ta " +
                "JOIN attributes a ON a.id = ta.attribute_id " +
                "AND a.chain_id = ta.chain_id " +
                "AND a.collection_id = ta.collection_id " +
                "JOIN attribute_keys ak ON ak.id = a.attribute_key_id " +
                "AND ak.chain_id = a.chain_id " +
                "AND ak.collection_id = a.collection_id " +
                "WHERE ta.chain_id = ? AND ta.collection_id = ? AND ta.token_id = ? " +
                "ORDER BY ta.source_kind ASC, ta.source_key ASC, ak.key ASC, a.value ASC",
        )
        .all(CHAIN_ID, COLLECTION_ID, TOKEN_ID) as TokenAttributeLinkRow[];
}
