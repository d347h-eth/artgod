import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
    TOKEN_ATTRIBUTE_SOURCE_KIND,
} from "../types/token-attributes.js";
import { OPENSEA_STREAM_INGESTION_STATUS } from "../types/browse.js";
import { TERRAFORMS_MAINNET_PRESET_COLLECTION } from "../extensions/terraforms.js";
import { resolveProjectPath } from "../utils/paths.js";
import { db, setDbPath } from "./db.js";
import { MigrationRunner } from "./migrations.js";

const TOKEN_ATTRIBUTE_SOURCE_MIGRATION = "040_token_attribute_sources.sql";
const TOKEN_ATTRIBUTE_SOURCE_ATTRIBUTE_INDEX_MIGRATION =
    "047_token_attributes_source_attribute_index.sql";
const TOKEN_ATTRIBUTE_SOURCE_ATTRIBUTE_INDEX =
    "token_attributes_source_attribute_idx";
const METADATA_REFRESH_FOLLOWUPS_MIGRATION =
    "041_metadata_refresh_followups_and_queue_outbox.sql";
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

type PresetCollectionRow = {
    collection_id: number;
    chain_id: number;
    slug: string;
    address: string;
    standard: string;
    status: string;
    token_scope_kind: string;
    scope_start_token_id: string | null;
    scope_total_supply: number | null;
    deployment_block: number | null;
    bootstrap_anchor_block: number | null;
    opensea_slug: string | null;
    opensea_status: string | null;
    opensea_stream_ingestion_status: string;
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

describe("MigrationRunner token attribute source attribute index", () => {
    let tempDir: string;
    let migrationsDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "artgod-source-attribute-index-"));
        migrationsDir = join(tempDir, "migrations");
        mkdirSync(migrationsDir);
        copyFileSync(
            resolveProjectPath(
                `database/migrations/${TOKEN_ATTRIBUTE_SOURCE_ATTRIBUTE_INDEX_MIGRATION}`,
            ),
            join(migrationsDir, TOKEN_ATTRIBUTE_SOURCE_ATTRIBUTE_INDEX_MIGRATION),
        );
        setDbPath(join(tempDir, "test.sqlite"));
        createTokenAttributeSourceSchema();
    });

    afterEach(() => {
        setDbPath(
            join(tmpdir(), "artgod-source-attribute-index-closed.sqlite"),
        );
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("creates the source-to-attribute lookup index", async () => {
        const migrations = new MigrationRunner(migrationsDir);
        await migrations.runMigrations();

        expect(selectTokenAttributeIndexes()).toContain(
            TOKEN_ATTRIBUTE_SOURCE_ATTRIBUTE_INDEX,
        );
        expect(selectAppliedMigrationNames()).toEqual([
            TOKEN_ATTRIBUTE_SOURCE_ATTRIBUTE_INDEX_MIGRATION,
        ]);
    });
});

describe("MigrationRunner metadata refresh follow-up schema", () => {
    let tempDir: string;
    let migrationsDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "artgod-followups-migration-"));
        migrationsDir = join(tempDir, "migrations");
        mkdirSync(migrationsDir);
        copyFileSync(
            resolveProjectPath(
                `database/migrations/${METADATA_REFRESH_FOLLOWUPS_MIGRATION}`,
            ),
            join(migrationsDir, METADATA_REFRESH_FOLLOWUPS_MIGRATION),
        );
        setDbPath(join(tempDir, "test.sqlite"));
    });

    afterEach(() => {
        setDbPath(join(tmpdir(), "artgod-followups-migration-closed.sqlite"));
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("creates queue outbox and metadata refresh follow-up tables", async () => {
        const migrations = new MigrationRunner(migrationsDir);
        await migrations.runMigrations();

        expect(selectTableNames()).toEqual(
            expect.arrayContaining([
                "queue_outbox",
                "metadata_refresh_runs",
                "metadata_refresh_extension_artifact_tasks",
            ]),
        );
        expect(selectColumnNames("metadata_refresh_runs")).toEqual(
            expect.arrayContaining([
                "run_id",
                "stats_job_json",
                "stats_queue_outbox_id",
            ]),
        );
        expect(selectAppliedMigrationNames()).toEqual([
            METADATA_REFRESH_FOLLOWUPS_MIGRATION,
        ]);
    });
});

describe("MigrationRunner preset collections", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "artgod-preset-migration-"));
        setDbPath(join(tempDir, "test.sqlite"));
    });

    afterEach(() => {
        setDbPath(join(tmpdir(), "artgod-preset-migration-closed.sqlite"));
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("seeds Terraforms as prepared collection id 1 without bootstrap data", async () => {
        const migrations = new MigrationRunner(
            resolveProjectPath("database/migrations"),
        );
        await migrations.runMigrations();

        const row = db
            .prepare<[]>(
                "SELECT collection_id, chain_id, slug, address, standard, status, " +
                    "token_scope_kind, scope_start_token_id, scope_total_supply, " +
                    "deployment_block, bootstrap_anchor_block, opensea_slug, opensea_status, " +
                    "opensea_stream_ingestion_status " +
                    "FROM collections WHERE collection_id = 1 LIMIT 1",
            )
            .get() as PresetCollectionRow | undefined;
        expect(row).toEqual({
            collection_id: TERRAFORMS_MAINNET_PRESET_COLLECTION.collectionId,
            chain_id: TERRAFORMS_MAINNET_PRESET_COLLECTION.chainId,
            slug: TERRAFORMS_MAINNET_PRESET_COLLECTION.slug,
            address: TERRAFORMS_MAINNET_PRESET_COLLECTION.address,
            standard: TERRAFORMS_MAINNET_PRESET_COLLECTION.standard,
            status: TERRAFORMS_MAINNET_PRESET_COLLECTION.status,
            token_scope_kind:
                TERRAFORMS_MAINNET_PRESET_COLLECTION.tokenScopeKind,
            scope_start_token_id: null,
            scope_total_supply: null,
            deployment_block:
                TERRAFORMS_MAINNET_PRESET_COLLECTION.deploymentBlock,
            bootstrap_anchor_block: null,
            opensea_slug: TERRAFORMS_MAINNET_PRESET_COLLECTION.openseaSlug,
            opensea_status: null,
            opensea_stream_ingestion_status:
                OPENSEA_STREAM_INGESTION_STATUS.Enabled,
        });
        expect(countRows("tokens")).toBe(0);
        expect(countRows("bootstrap_runs")).toBe(0);
        expect(countRows("collection_extension_installs")).toBe(0);
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

function createTokenAttributeSourceSchema(): void {
    db.exec(`
        CREATE TABLE token_attributes (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            contract_address TEXT NOT NULL,
            token_id TEXT NOT NULL,
            attribute_id INTEGER NOT NULL,
            source_kind TEXT NOT NULL,
            source_key TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (chain_id, collection_id, token_id, attribute_id, source_kind, source_key)
        );
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
        .prepare<
            []
        >("SELECT ta.token_id AS token_id, ak.key AS key, a.value AS value, " + "ta.source_kind AS source_kind, ta.source_key AS source_key, ta.created_at AS created_at " + "FROM token_attributes ta " + "JOIN attributes a ON a.id = ta.attribute_id " + "JOIN attribute_keys ak ON ak.id = a.attribute_key_id " + "ORDER BY ta.token_id ASC")
        .all() as TokenAttributeSourceRow[];
}

function selectTokenAttributeIndexes(): string[] {
    const rows = db
        .prepare<
            []
        >("SELECT name FROM sqlite_master " + "WHERE type = 'index' AND tbl_name = 'token_attributes' " + "ORDER BY name ASC")
        .all() as SqliteNameRow[];
    return rows.map((row) => row.name);
}

function selectAppliedMigrationNames(): string[] {
    const rows = db
        .prepare<[]>("SELECT name FROM migrations ORDER BY name ASC")
        .all() as SqliteNameRow[];
    return rows.map((row) => row.name);
}

function selectTableNames(): string[] {
    const rows = db
        .prepare<
            []
        >("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC")
        .all() as SqliteNameRow[];
    return rows.map((row) => row.name);
}

function selectColumnNames(table: string): string[] {
    const rows = db
        .prepare<[]>(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
        .all() as SqliteNameRow[];
    return rows.map((row) => row.name);
}

function countRows(table: string): number {
    const row = db
        .prepare<[]>(`SELECT COUNT(1) AS count FROM "${table.replaceAll('"', '""')}"`)
        .get() as { count: number };
    return row.count;
}
