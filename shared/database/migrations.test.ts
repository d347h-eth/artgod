import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
    TOKEN_ATTRIBUTE_SOURCE_KIND,
} from "../types/token-attributes.js";
import { resolveProjectPath } from "../utils/paths.js";
import { db, setDbPath } from "./db.js";
import { MigrationRunner } from "./migrations.js";

const TOKEN_ATTRIBUTE_SOURCE_MIGRATION = "040_token_attribute_sources.sql";
const CHAIN_ID = 1;
const COLLECTION_ID = 10;
const CONTRACT_ADDRESS = "0xabc0000000000000000000000000000000000000";

type TokenAttributeSourceRow = {
    token_id: string;
    key: string;
    value: string;
    source_kind: string;
    source_key: string;
    created_at: string | null;
};

type SqliteNameRow = {
    name: string;
};

describe("MigrationRunner token attribute source upgrades", () => {
    let tempDir: string;
    let migrationsDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "artgod-migration-upgrade-"));
        migrationsDir = join(tempDir, "migrations");
        mkdirSync(migrationsDir);
        copyFileSync(
            resolveProjectPath(
                `database/migrations/${TOKEN_ATTRIBUTE_SOURCE_MIGRATION}`,
            ),
            join(migrationsDir, TOKEN_ATTRIBUTE_SOURCE_MIGRATION),
        );
        setDbPath(join(tempDir, "test.sqlite"));
        createPreTokenAttributeSourceSchema();
    });

    afterEach(() => {
        setDbPath(join(tmpdir(), "artgod-migration-upgrade-closed.sqlite"));
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("preserves existing token attribute links as canonical metadata sources", async () => {
        seedPreTokenAttributeSourceLink({
            tokenId: "1",
            key: "Mode",
            value: "Terrain",
            createdAt: "2026-06-01T00:00:00.000Z",
        });
        seedPreTokenAttributeSourceLink({
            tokenId: "2",
            key: "Seed",
            value: "9964",
            createdAt: "2026-06-02T00:00:00.000Z",
        });

        const migrations = new MigrationRunner(migrationsDir);
        await migrations.runMigrations();

        const rows = selectTokenAttributeSourceRows();
        expect(rows).toEqual([
            {
                token_id: "1",
                key: "Mode",
                value: "Terrain",
                source_kind: TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
                source_key: TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
                created_at: "2026-06-01T00:00:00.000Z",
            },
            {
                token_id: "2",
                key: "Seed",
                value: "9964",
                source_kind: TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
                source_key: TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
                created_at: "2026-06-02T00:00:00.000Z",
            },
        ]);
        expect(selectTokenAttributeIndexes()).toEqual(
            expect.arrayContaining([
                "token_attributes_attribute_idx",
                "token_attributes_collection_idx",
                "token_attributes_source_token_idx",
            ]),
        );
        expect(selectAppliedMigrationNames()).toEqual([
            TOKEN_ATTRIBUTE_SOURCE_MIGRATION,
        ]);
    });
});

function createPreTokenAttributeSourceSchema(): void {
    db.exec(`
        CREATE TABLE attribute_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            contract_address TEXT NOT NULL,
            key TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (chain_id, collection_id, key)
        );

        CREATE TABLE attributes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            contract_address TEXT NOT NULL,
            attribute_key_id INTEGER NOT NULL,
            value TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (chain_id, collection_id, attribute_key_id, value),
            FOREIGN KEY(attribute_key_id) REFERENCES attribute_keys(id)
        );

        CREATE TABLE token_attributes (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            contract_address TEXT NOT NULL,
            token_id TEXT NOT NULL,
            attribute_id INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (chain_id, collection_id, token_id, attribute_id),
            FOREIGN KEY(attribute_id) REFERENCES attributes(id)
        );

        CREATE INDEX token_attributes_attribute_idx
            ON token_attributes (attribute_id);
        CREATE INDEX token_attributes_collection_idx
            ON token_attributes (chain_id, collection_id, token_id);
    `);
}

function seedPreTokenAttributeSourceLink(input: {
    tokenId: string;
    key: string;
    value: string;
    createdAt: string;
}): void {
    db.prepare<{
        chainId: number;
        collectionId: number;
        contractAddress: string;
        key: string;
    }>(
        "INSERT INTO attribute_keys " +
            "(chain_id, collection_id, contract_address, key) " +
            "VALUES (@chainId, @collectionId, @contractAddress, @key)",
    ).run({
        chainId: CHAIN_ID,
        collectionId: COLLECTION_ID,
        contractAddress: CONTRACT_ADDRESS,
        key: input.key,
    });
    const keyRow = db
        .prepare<{
            chainId: number;
            collectionId: number;
            key: string;
        }>(
            "SELECT id FROM attribute_keys " +
                "WHERE chain_id = @chainId AND collection_id = @collectionId AND key = @key",
        )
        .get({
            chainId: CHAIN_ID,
            collectionId: COLLECTION_ID,
            key: input.key,
        }) as { id: number };

    db.prepare<{
        chainId: number;
        collectionId: number;
        contractAddress: string;
        attributeKeyId: number;
        value: string;
    }>(
        "INSERT INTO attributes " +
            "(chain_id, collection_id, contract_address, attribute_key_id, value) " +
            "VALUES (@chainId, @collectionId, @contractAddress, @attributeKeyId, @value)",
    ).run({
        chainId: CHAIN_ID,
        collectionId: COLLECTION_ID,
        contractAddress: CONTRACT_ADDRESS,
        attributeKeyId: keyRow.id,
        value: input.value,
    });
    const attributeRow = db
        .prepare<{
            chainId: number;
            collectionId: number;
            attributeKeyId: number;
            value: string;
        }>(
            "SELECT id FROM attributes " +
                "WHERE chain_id = @chainId AND collection_id = @collectionId " +
                "AND attribute_key_id = @attributeKeyId AND value = @value",
        )
        .get({
            chainId: CHAIN_ID,
            collectionId: COLLECTION_ID,
            attributeKeyId: keyRow.id,
            value: input.value,
        }) as { id: number };

    db.prepare<{
        chainId: number;
        collectionId: number;
        contractAddress: string;
        tokenId: string;
        attributeId: number;
        createdAt: string;
    }>(
        "INSERT INTO token_attributes " +
            "(chain_id, collection_id, contract_address, token_id, attribute_id, created_at) " +
            "VALUES (@chainId, @collectionId, @contractAddress, @tokenId, @attributeId, @createdAt)",
    ).run({
        chainId: CHAIN_ID,
        collectionId: COLLECTION_ID,
        contractAddress: CONTRACT_ADDRESS,
        tokenId: input.tokenId,
        attributeId: attributeRow.id,
        createdAt: input.createdAt,
    });
}

function selectTokenAttributeSourceRows(): TokenAttributeSourceRow[] {
    return db
        .prepare<[]>(
            "SELECT ta.token_id AS token_id, ak.key AS key, a.value AS value, " +
                "ta.source_kind AS source_kind, ta.source_key AS source_key, ta.created_at AS created_at " +
                "FROM token_attributes ta " +
                "JOIN attributes a ON a.id = ta.attribute_id " +
                "JOIN attribute_keys ak ON ak.id = a.attribute_key_id " +
                "ORDER BY ta.token_id ASC",
        )
        .all() as TokenAttributeSourceRow[];
}

function selectTokenAttributeIndexes(): string[] {
    const rows = db
        .prepare<[]>(
            "SELECT name FROM sqlite_master " +
                "WHERE type = 'index' AND tbl_name = 'token_attributes' " +
                "ORDER BY name ASC",
        )
        .all() as SqliteNameRow[];
    return rows.map((row) => row.name);
}

function selectAppliedMigrationNames(): string[] {
    const rows = db
        .prepare<[]>("SELECT name FROM migrations ORDER BY name ASC")
        .all() as SqliteNameRow[];
    return rows.map((row) => row.name);
}
