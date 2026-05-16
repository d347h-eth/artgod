import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "../database/db.js";
import type { ApmPort, SpanAttributes } from "../observability/apm.js";
import { SqliteCollectionsReadModel } from "./collections.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

class CapturingApm implements ApmPort {
    readonly spans: Array<{ name: string; attributes: SpanAttributes }> = [];

    async withSpan<T>(
        name: string,
        attributes: SpanAttributes,
        run: () => Promise<T>,
    ): Promise<T> {
        this.spans.push({ name, attributes });
        return run();
    }

    withSyncSpan<T>(name: string, attributes: SpanAttributes, run: () => T): T {
        this.spans.push({ name, attributes });
        return run();
    }
}

describe("SqliteCollectionsReadModel observability", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "artgod-collections-read-"));
        setDbPath(join(tempDir, "test.sqlite"));
        createSchema();
    });

    afterEach(() => {
        setDbPath(join(tmpdir(), "artgod-collections-read-closed.sqlite"));
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("does not run a previous-page token query on first page", () => {
        insertToken("1", "100");
        insertToken("2", "200");
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const page = readModel.listCollectionTokens({
            chainId: 1,
            collectionId: 1,
            tokenStatus: "listed",
            limit: 1,
        });

        expect(page.prevCursor).toBeNull();
        expect(page.nextCursor).toEqual(expect.any(String));
        expect(apm.spans.map((span) => span.name)).not.toContain(
            "backend.collection.db.tokens_prev_cursor",
        );
        expect(apm.spans).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    name: "backend.collection.db.tokens_page",
                    attributes: expect.objectContaining({
                        "artgod.collection.token_status": "listed",
                        "artgod.collection.cursor_present": false,
                    }),
                }),
            ]),
        );
    });

    it("excludes hidden trait facet keys in SQL-facing facet reads", () => {
        insertTraitStat("Hat", "Beanie", 2);
        insertTraitStat("???", "123456789", 1);
        const apm = new CapturingApm();
        const readModel = new SqliteCollectionsReadModel([ZERO_ADDRESS], apm);

        const facets = readModel.listCollectionTraitFacets(1, 1, undefined, {
            excludeKeys: ["???"],
        });

        expect(facets.map((facet) => facet.key)).toEqual(["Hat"]);
        expect(apm.spans).toContainEqual({
            name: "backend.collection.db.trait_facets",
            attributes: {
                "artgod.chain_id": 1,
                "artgod.collection_id": 1,
                "artgod.collection.owner_present": false,
                "artgod.collection.exclude_keys_count": 1,
            },
        });
    });
});

function createSchema(): void {
    db.exec(`
        CREATE TABLE collections (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            slug TEXT NOT NULL,
            address TEXT NOT NULL,
            standard TEXT NOT NULL,
            status TEXT NOT NULL,
            deployment_block INTEGER,
            bootstrap_anchor_block INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (chain_id, collection_id)
        );
        CREATE TABLE tokens (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            token_id TEXT NOT NULL,
            PRIMARY KEY (chain_id, collection_id, token_id)
        );
        CREATE TABLE token_metadata (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            token_id TEXT NOT NULL,
            name TEXT,
            image TEXT,
            animation_url TEXT,
            attributes_json TEXT,
            updated_at TEXT,
            PRIMARY KEY (chain_id, collection_id, token_id)
        );
        CREATE TABLE orders (
            id TEXT PRIMARY KEY,
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            token_id TEXT,
            price TEXT,
            currency TEXT,
            source_scope_kind TEXT NOT NULL,
            side TEXT,
            source_status TEXT NOT NULL,
            fillability_status TEXT NOT NULL,
            valid_from INTEGER,
            valid_until INTEGER
        );
        CREATE TABLE attribute_keys (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            key TEXT NOT NULL
        );
        CREATE TABLE attributes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            attribute_key_id INTEGER NOT NULL,
            value TEXT NOT NULL
        );
        CREATE TABLE collection_trait_stats (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            attribute_key_id INTEGER NOT NULL,
            attribute_id INTEGER NOT NULL,
            token_count INTEGER NOT NULL
        );
        CREATE TABLE token_attributes (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            token_id TEXT NOT NULL,
            attribute_id INTEGER NOT NULL
        );
        CREATE TABLE nft_balances (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            token_id TEXT NOT NULL,
            owner TEXT NOT NULL,
            amount TEXT NOT NULL
        );
    `);
}

function insertToken(tokenId: string, price: string): void {
    db.prepare(
        "INSERT INTO tokens (chain_id, collection_id, token_id) VALUES (?, ?, ?)",
    ).run(1, 1, tokenId);
    db.prepare(
        "INSERT INTO token_metadata (chain_id, collection_id, token_id, name, image, animation_url, attributes_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(1, 1, tokenId, `Token ${tokenId}`, null, null, "[]", "2026-01-01");
    db.prepare(
        "INSERT INTO orders (id, chain_id, collection_id, token_id, price, currency, source_scope_kind, side, source_status, fillability_status, valid_from, valid_until) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        `order-${tokenId}`,
        1,
        1,
        tokenId,
        price,
        ZERO_ADDRESS,
        "token",
        "sell",
        "active",
        "fillable",
        null,
        null,
    );
}

function insertTraitStat(key: string, value: string, tokenCount: number): void {
    const keyResult = db
        .prepare(
            "INSERT INTO attribute_keys (chain_id, collection_id, key) VALUES (?, ?, ?)",
        )
        .run(1, 1, key);
    const attributeResult = db
        .prepare(
            "INSERT INTO attributes (chain_id, collection_id, attribute_key_id, value) VALUES (?, ?, ?, ?)",
        )
        .run(1, 1, keyResult.lastInsertRowid, value);
    db.prepare(
        "INSERT INTO collection_trait_stats (chain_id, collection_id, attribute_key_id, attribute_id, token_count) VALUES (?, ?, ?, ?, ?)",
    ).run(
        1,
        1,
        keyResult.lastInsertRowid,
        attributeResult.lastInsertRowid,
        tokenCount,
    );
}
