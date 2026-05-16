import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "../database/db.js";
import { ARTGOD_SPAN_ATTRIBUTE } from "../observability/artgod-span-attributes.js";
import type { ApmPort, SpanAttributes } from "../observability/apm.js";
import {
    ACTIVITY_FEED_FILTER_KIND,
    ACTIVITY_KIND,
    ACTIVITY_SCOPE_KIND,
    ACTIVITY_SOURCE_KIND,
} from "../types/activity-feed.js";
import { SqliteActivitiesReadModel } from "./activities.js";

const CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000001";

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

describe("SqliteActivitiesReadModel observability", () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), "artgod-activities-read-"));
        setDbPath(join(tempDir, "test.sqlite"));
        createSchema();
    });

    afterEach(() => {
        setDbPath(join(tmpdir(), "artgod-activities-read-closed.sqlite"));
        rmSync(tempDir, { recursive: true, force: true });
    });

    it("short-circuits exact trait filters when no activity tokens match", () => {
        insertActivity(1, "1", 100);
        insertActivity(2, "2", 200);
        insertTokenTrait("1", "Hat", "Beanie");
        const apm = new CapturingApm();
        const readModel = new SqliteActivitiesReadModel(apm);

        const page = readModel.listCollectionActivities({
            chainId: 1,
            collectionId: 1,
            kind: ACTIVITY_FEED_FILTER_KIND.Transfers,
            traitFilters: [{ key: "Mode", value: "Terrain" }],
            limit: 250,
        });

        expect(page.items).toEqual([]);
        expect(page.totalItems).toBe(0);
        expect(apm.spans.map((span) => span.name)).toContain(
            "backend.activity.db.trait_filter_token_candidates",
        );
        expect(apm.spans.map((span) => span.name)).not.toContain(
            "backend.activity.db.query_rows",
        );
        expect(apm.spans.map((span) => span.name)).not.toContain(
            "backend.activity.db.count",
        );
    });

    it("skips total count when the first activity page is not full", () => {
        insertActivity(1, "1", 100);
        insertActivity(2, "2", 300);
        insertActivity(3, "1", 200);
        insertTokenTrait("1", "Mode", "Terrain");
        insertTokenTrait("2", "Mode", "Space");
        const apm = new CapturingApm();
        const readModel = new SqliteActivitiesReadModel(apm);

        const page = readModel.listCollectionActivities({
            chainId: 1,
            collectionId: 1,
            kind: ACTIVITY_FEED_FILTER_KIND.Transfers,
            traitFilters: [{ key: "Mode", value: "Terrain" }],
            limit: 250,
        });

        expect(page.items.map((activity) => activity.id)).toEqual([3, 1]);
        expect(page.totalItems).toBe(2);
        expect(page.nextCursor).toBeNull();
        expect(apm.spans.map((span) => span.name)).toEqual(
            expect.arrayContaining([
                "backend.activity.db.trait_filter_token_candidates",
                "backend.activity.db.query_rows",
            ]),
        );
        expect(apm.spans.map((span) => span.name)).not.toContain(
            "backend.activity.db.count",
        );
    });

    it("runs total count when the first activity page has a next cursor", () => {
        insertActivity(1, "1", 100);
        insertActivity(2, "1", 200);
        insertTokenTrait("1", "Mode", "Terrain");
        const apm = new CapturingApm();
        const readModel = new SqliteActivitiesReadModel(apm);

        const page = readModel.listCollectionActivities({
            chainId: 1,
            collectionId: 1,
            kind: ACTIVITY_FEED_FILTER_KIND.Transfers,
            traitFilters: [{ key: "Mode", value: "Terrain" }],
            limit: 1,
        });

        expect(page.items.map((activity) => activity.id)).toEqual([2]);
        expect(page.totalItems).toBe(2);
        expect(page.nextCursor).toEqual(expect.any(String));
        expect(apm.spans).toContainEqual({
            name: "backend.activity.db.count",
            attributes: expect.objectContaining({
                [ARTGOD_SPAN_ATTRIBUTE.ActivityQuerySource]: "raw",
            }),
        });
    });
});

function createSchema(): void {
    db.exec(`
        CREATE TABLE activities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            scope_kind TEXT NOT NULL,
            kind TEXT NOT NULL,
            contract_address TEXT NOT NULL,
            token_id TEXT,
            occurred_at INTEGER NOT NULL,
            source_kind TEXT NOT NULL,
            source_name TEXT NOT NULL,
            order_id TEXT,
            block_number INTEGER,
            tx_hash TEXT,
            log_index INTEGER,
            from_address TEXT,
            to_address TEXT,
            maker TEXT,
            taker TEXT,
            side TEXT,
            amount TEXT,
            price TEXT,
            currency TEXT,
            payload_json TEXT,
            dedupe_key TEXT NOT NULL,
            is_open INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (chain_id, dedupe_key)
        );
        CREATE INDEX activities_collection_kind_feed_idx
            ON activities (chain_id, collection_id, kind, occurred_at DESC, id DESC);
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
        CREATE TABLE token_attributes (
            chain_id INTEGER NOT NULL,
            collection_id INTEGER NOT NULL,
            token_id TEXT NOT NULL,
            attribute_id INTEGER NOT NULL
        );
    `);
}

function insertActivity(id: number, tokenId: string, occurredAt: number): void {
    db.prepare(
        "INSERT INTO activities (id, chain_id, collection_id, scope_kind, kind, contract_address, token_id, occurred_at, source_kind, source_name, dedupe_key) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        id,
        1,
        1,
        ACTIVITY_SCOPE_KIND.Token,
        ACTIVITY_KIND.Transfer,
        CONTRACT_ADDRESS,
        tokenId,
        occurredAt,
        ACTIVITY_SOURCE_KIND.Onchain,
        "test",
        `activity-${id}`,
    );
}

function insertTokenTrait(tokenId: string, key: string, value: string): void {
    const keyId = getOrCreateAttributeKey(key);
    const attributeId = getOrCreateAttribute(keyId, value);
    db.prepare(
        "INSERT INTO token_attributes (chain_id, collection_id, token_id, attribute_id) VALUES (?, ?, ?, ?)",
    ).run(1, 1, tokenId, attributeId);
}

function getOrCreateAttributeKey(key: string): number {
    const row = db
        .prepare(
            "SELECT id FROM attribute_keys WHERE chain_id = ? AND collection_id = ? AND key = ?",
        )
        .get(1, 1, key) as { id: number } | undefined;
    if (row) {
        return row.id;
    }
    const result = db
        .prepare(
            "INSERT INTO attribute_keys (chain_id, collection_id, key) VALUES (?, ?, ?)",
        )
        .run(1, 1, key);
    return Number(result.lastInsertRowid);
}

function getOrCreateAttribute(attributeKeyId: number, value: string): number {
    const row = db
        .prepare(
            "SELECT id FROM attributes WHERE chain_id = ? AND collection_id = ? AND attribute_key_id = ? AND value = ?",
        )
        .get(1, 1, attributeKeyId, value) as { id: number } | undefined;
    if (row) {
        return row.id;
    }
    const result = db
        .prepare(
            "INSERT INTO attributes (chain_id, collection_id, attribute_key_id, value) VALUES (?, ?, ?, ?)",
        )
        .run(1, 1, attributeKeyId, value);
    return Number(result.lastInsertRowid);
}
