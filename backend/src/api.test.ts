import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";

const MILADY_ADDRESS = "0x1111111111111111111111111111111111111111";
const TERRAFORMS_ADDRESS = "0x2222222222222222222222222222222222222222";

type ResolveApiRequest = (method: string, url: URL, dependencies: any) => {
    statusCode: number;
    payload: any;
};

let dbPath = "";
let resolveApiRequest: ResolveApiRequest;
let dependencies: any;

beforeAll(async () => {
    dbPath = path.join(os.tmpdir(), `artgod-backend-api-${Date.now()}.sqlite`);
    process.env.ARTGOD_DB_PATH = dbPath;
    setDbPath(dbPath);

    const migrationRunner = createMigrationRunner();
    await migrationRunner.runMigrations();
    seedData();

    const backendModule = await import("./index.js");
    const readModels = await import("@artgod/shared/read-models");

    resolveApiRequest = backendModule.resolveApiRequest as ResolveApiRequest;
    dependencies = {
        defaultChainId: 1,
        chainsReadModel: new readModels.SqliteChainsReadModel(),
        collectionsReadModel: new readModels.SqliteCollectionsReadModel(),
    };
});

afterAll(async () => {
    await Promise.all([
        fs.rm(dbPath, { force: true }),
        fs.rm(`${dbPath}-shm`, { force: true }),
        fs.rm(`${dbPath}-wal`, { force: true }),
    ]);
});

describe("backend api routes", () => {
    it("returns the default chain", () => {
        const result = resolve("GET", "/api/chains/default");
        expect(result.statusCode).toBe(200);
        expect(result.payload.chain.publicChainId).toBe(1);
        expect(result.payload.chain.slug).toBe("ethereum");
    });

    it("lists collections with cursor pagination", () => {
        const first = resolve("GET", "/api/ethereum/collections?limit=1");
        expect(first.statusCode).toBe(200);
        expect(first.payload.page.items).toHaveLength(1);
        expect(first.payload.page.items[0].slug).toBe("milady");
        expect(first.payload.page.nextCursor).toEqual(expect.any(String));

        const second = resolve(
            "GET",
            `/api/ethereum/collections?limit=1&cursor=${encodeURIComponent(first.payload.page.nextCursor)}`,
        );
        expect(second.statusCode).toBe(200);
        expect(second.payload.page.items).toHaveLength(1);
        expect(second.payload.page.items[0].address).toBe(TERRAFORMS_ADDRESS);
    });

    it("filters collections by status", () => {
        const result = resolve(
            "GET",
            "/api/1/collections?status=bootstrapping&limit=10",
        );
        expect(result.statusCode).toBe(200);
        expect(result.payload.page.items).toHaveLength(1);
        expect(result.payload.page.items[0].address).toBe(TERRAFORMS_ADDRESS);
    });

    it("returns collection detail with facets and paged tokens", () => {
        const result = resolve("GET", "/api/ethereum/milady?limit=2");
        expect(result.statusCode).toBe(200);
        expect(result.payload.collection.address).toBe(MILADY_ADDRESS);
        expect(result.payload.tokens.items).toHaveLength(2);
        expect(result.payload.tokens.prevCursor).toBeNull();
        expect(result.payload.tokens.nextCursor).toEqual(expect.any(String));
        expect(result.payload.tokens.totalItems).toBe(3);
        expect(result.payload.tokens.rangeStart).toBe(1);
        expect(result.payload.tokens.rangeEnd).toBe(2);
        expect(result.payload.tokens.currentPage).toBe(1);
        expect(result.payload.tokens.totalPages).toBe(2);
        expect(result.payload.traits.facets).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ key: "Hat" }),
                expect.objectContaining({ key: "Mood" }),
            ]),
        );
    });

    it("supports backward paging with prevCursor", () => {
        const first = resolve("GET", "/api/ethereum/milady?limit=1");
        const second = resolve(
            "GET",
            `/api/ethereum/milady?limit=1&cursor=${encodeURIComponent(first.payload.tokens.nextCursor)}`,
        );
        const third = resolve(
            "GET",
            `/api/ethereum/milady?limit=1&cursor=${encodeURIComponent(second.payload.tokens.nextCursor)}`,
        );

        expect(second.payload.tokens.prevCursor).toBeNull();
        expect(third.payload.tokens.prevCursor).toEqual(expect.any(String));

        const previousOfThird = resolve(
            "GET",
            `/api/ethereum/milady?limit=1&cursor=${encodeURIComponent(third.payload.tokens.prevCursor)}`,
        );
        expect(previousOfThird.payload.tokens.items[0].tokenId).toBe("2");
    });

    it("applies AND semantics across different trait keys", () => {
        const result = resolve(
            "GET",
            "/api/1/milady?traits=Hat:Beanie,Mood:Calm&limit=10",
        );
        expect(result.statusCode).toBe(200);
        expect(
            result.payload.tokens.items.map((token: { tokenId: string }) => token.tokenId),
        ).toEqual(["1"]);
    });

    it("applies OR semantics for values within the same trait key", () => {
        const result = resolve(
            "GET",
            "/api/1/milady?traits=Hat:Beanie,Hat:Cap&limit=10",
        );
        expect(result.statusCode).toBe(200);
        expect(
            result.payload.tokens.items.map((token: { tokenId: string }) => token.tokenId),
        ).toEqual(["1", "2", "10"]);
    });

    it("resolves collection by address", () => {
        const result = resolve("GET", `/api/ethereum/${MILADY_ADDRESS}?limit=10`);
        expect(result.statusCode).toBe(200);
        expect(result.payload.collection.slug).toBe("milady");
    });
});

function resolve(method: string, pathWithQuery: string): {
    statusCode: number;
    payload: any;
} {
    return resolveApiRequest(method, new URL(pathWithQuery, "http://localhost"), dependencies);
}

function seedData(): void {
    db.exec(
        [
            "DELETE FROM collection_trait_stats;",
            "DELETE FROM token_attributes;",
            "DELETE FROM attributes;",
            "DELETE FROM attribute_keys;",
            "DELETE FROM token_metadata;",
            "DELETE FROM tokens;",
            "DELETE FROM collections;",
        ].join("\n"),
    );

    db.prepare(
        "INSERT INTO collections " +
            "(chain_id, collection_id, slug, address, standard, status, deployment_block, bootstrap_anchor_block, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        1,
        "milady-main",
        "milady",
        MILADY_ADDRESS,
        "erc721",
        "live",
        1,
        null,
        "2026-01-01T00:00:00Z",
        "2026-01-01T00:00:00Z",
    );

    db.prepare(
        "INSERT INTO collections " +
            "(chain_id, collection_id, slug, address, standard, status, deployment_block, bootstrap_anchor_block, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        1,
        "terraforms-main",
        null,
        TERRAFORMS_ADDRESS,
        "erc721",
        "bootstrapping",
        1,
        null,
        "2025-12-01T00:00:00Z",
        "2025-12-01T00:00:00Z",
    );

    const insertToken = db.prepare(
        "INSERT INTO tokens (chain_id, contract_address, token_id, created_at, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    );
    insertToken.run(1, MILADY_ADDRESS, "1");
    insertToken.run(1, MILADY_ADDRESS, "2");
    insertToken.run(1, MILADY_ADDRESS, "10");

    const insertMetadata = db.prepare(
        "INSERT INTO token_metadata " +
            "(chain_id, contract_address, token_id, uri, name, image, attributes_json, raw_json, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );

    insertMetadata.run(
        1,
        MILADY_ADDRESS,
        "1",
        "ipfs://1",
        "Milady #1",
        "https://example.com/1.png",
        JSON.stringify([
            { traitType: "Hat", value: "Beanie" },
            { traitType: "Mood", value: "Calm" },
        ]),
        "{}",
        "2026-01-01T00:00:00Z",
    );
    insertMetadata.run(
        1,
        MILADY_ADDRESS,
        "2",
        "ipfs://2",
        "Milady #2",
        "https://example.com/2.png",
        JSON.stringify([
            { traitType: "Hat", value: "Beanie" },
            { traitType: "Mood", value: "Angry" },
        ]),
        "{}",
        "2026-01-01T00:00:00Z",
    );
    insertMetadata.run(
        1,
        MILADY_ADDRESS,
        "10",
        "ipfs://10",
        "Milady #10",
        "https://example.com/10.png",
        JSON.stringify([
            { traitType: "Hat", value: "Cap" },
            { traitType: "Mood", value: "Calm" },
        ]),
        "{}",
        "2026-01-01T00:00:00Z",
    );

    const hatKeyId = insertAttributeKey("Hat");
    const moodKeyId = insertAttributeKey("Mood");

    const beanieId = insertAttribute(hatKeyId, "Beanie");
    const capId = insertAttribute(hatKeyId, "Cap");
    const calmId = insertAttribute(moodKeyId, "Calm");
    const angryId = insertAttribute(moodKeyId, "Angry");

    const insertTokenAttribute = db.prepare(
        "INSERT INTO token_attributes (chain_id, contract_address, token_id, attribute_id) VALUES (?, ?, ?, ?)",
    );

    insertTokenAttribute.run(1, MILADY_ADDRESS, "1", beanieId);
    insertTokenAttribute.run(1, MILADY_ADDRESS, "1", calmId);
    insertTokenAttribute.run(1, MILADY_ADDRESS, "2", beanieId);
    insertTokenAttribute.run(1, MILADY_ADDRESS, "2", angryId);
    insertTokenAttribute.run(1, MILADY_ADDRESS, "10", capId);
    insertTokenAttribute.run(1, MILADY_ADDRESS, "10", calmId);

    const insertTraitStats = db.prepare(
        "INSERT INTO collection_trait_stats (chain_id, contract_address, attribute_key_id, attribute_id, token_count) VALUES (?, ?, ?, ?, ?)",
    );

    insertTraitStats.run(1, MILADY_ADDRESS, hatKeyId, beanieId, 2);
    insertTraitStats.run(1, MILADY_ADDRESS, hatKeyId, capId, 1);
    insertTraitStats.run(1, MILADY_ADDRESS, moodKeyId, calmId, 2);
    insertTraitStats.run(1, MILADY_ADDRESS, moodKeyId, angryId, 1);
}

function insertAttributeKey(key: string): number {
    db.prepare(
        "INSERT INTO attribute_keys (chain_id, contract_address, key) VALUES (?, ?, ?)",
    ).run(1, MILADY_ADDRESS, key);

    const row = db
        .prepare<[number, string, string]>(
            "SELECT id FROM attribute_keys WHERE chain_id = ? AND contract_address = ? AND key = ?",
        )
        .get(1, MILADY_ADDRESS, key) as { id: number } | undefined;
    if (!row) throw new Error(`Missing attribute key: ${key}`);
    return row.id;
}

function insertAttribute(attributeKeyId: number, value: string): number {
    db.prepare(
        "INSERT INTO attributes (chain_id, contract_address, attribute_key_id, value) VALUES (?, ?, ?, ?)",
    ).run(1, MILADY_ADDRESS, attributeKeyId, value);

    const row = db
        .prepare<[number, string, number, string]>(
            "SELECT id FROM attributes WHERE chain_id = ? AND contract_address = ? AND attribute_key_id = ? AND value = ?",
        )
        .get(1, MILADY_ADDRESS, attributeKeyId, value) as
        | { id: number }
        | undefined;
    if (!row) throw new Error(`Missing attribute: ${value}`);
    return row.id;
}
