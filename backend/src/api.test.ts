import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";

const MILADY_ADDRESS = "0x1111111111111111111111111111111111111111";
const TERRAFORMS_ADDRESS = "0x2222222222222222222222222222222222222222";

let dbPath = "";
let app: FastifyInstance | null = null;

beforeAll(async () => {
    dbPath = path.join(
        os.tmpdir(),
        `artgod-backend-api-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
    );
    process.env.ARTGOD_DB_PATH = dbPath;
    setDbPath(dbPath);

    const migrationRunner = createMigrationRunner();
    await migrationRunner.runMigrations();
    seedData();

    const appModule = await import("./http-app.js");
    const chainsUseCaseModule =
        await import("./application/use-cases/chains/get-default-chain.js");
    const listCollectionsUseCaseModule =
        await import("./application/use-cases/collections/list-collections.js");
    const collectionDetailUseCaseModule =
        await import("./application/use-cases/collections/get-collection-detail.js");
    const runtimeHealthUseCaseModule =
        await import("./application/use-cases/health/get-runtime-health.js");
    const sqliteRuntimeHealthModule =
        await import("./infra/runtime-health/sqlite-runtime-health.js");
    const readModels = await import("@artgod/shared/read-models");

    const chainsReadModel = new readModels.SqliteChainsReadModel();
    const collectionsReadModel = new readModels.SqliteCollectionsReadModel();
    const getDefaultChainUseCase =
        new chainsUseCaseModule.GetDefaultChainUseCase(1, chainsReadModel);
    const listCollectionsUseCase =
        new listCollectionsUseCaseModule.ListCollectionsUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
        );
    const getCollectionDetailUseCase =
        new collectionDetailUseCaseModule.GetCollectionDetailUseCase(
            1,
            chainsReadModel,
            collectionsReadModel,
        );
    const runtimeHealthUseCase =
        new runtimeHealthUseCaseModule.GetRuntimeHealthUseCase(
            new sqliteRuntimeHealthModule.SqliteRuntimeHealthAdapter(),
            {
                async assertJobsStreamExists(streamName: string) {
                    if (streamName !== "artgod-jobs") {
                        throw new Error(`Unexpected jobs stream ${streamName}`);
                    }
                },
            },
            "artgod-jobs",
        );
    const bootstrapRepositoryModule =
        await import("./infra/bootstrap/sqlite-bootstrap-runs.js");
    const createBootstrapUseCaseModule =
        await import("./application/use-cases/bootstrap/create-bootstrap-run.js");
    const getBootstrapStatusUseCaseModule =
        await import("./application/use-cases/bootstrap/get-bootstrap-status.js");
    const listBootstrapRunsUseCaseModule =
        await import("./application/use-cases/bootstrap/list-bootstrap-runs.js");
    const getBootstrapRunDetailUseCaseModule =
        await import("./application/use-cases/bootstrap/get-bootstrap-run-detail.js");
    const retryBootstrapRunFailedTasksUseCaseModule =
        await import("./application/use-cases/bootstrap/retry-bootstrap-run-failed-tasks.js");

    const bootstrapRepository =
        new bootstrapRepositoryModule.SqliteBootstrapRunsRepository();
    const bootstrapQueueMock = {
        async publishBootstrapStart() {},
        async publishBootstrapMetadataProcess() {},
    };
    const createBootstrapRunUseCase =
        new createBootstrapUseCaseModule.CreateBootstrapRunUseCase(
            1,
            chainsReadModel,
            bootstrapRepository,
            bootstrapQueueMock,
        );
    const getBootstrapStatusUseCase =
        new getBootstrapStatusUseCaseModule.GetBootstrapStatusUseCase(
            1,
            chainsReadModel,
            bootstrapRepository,
        );
    const listBootstrapRunsUseCase =
        new listBootstrapRunsUseCaseModule.ListBootstrapRunsUseCase(
            1,
            chainsReadModel,
            bootstrapRepository,
        );
    const getBootstrapRunDetailUseCase =
        new getBootstrapRunDetailUseCaseModule.GetBootstrapRunDetailUseCase(
            1,
            chainsReadModel,
            bootstrapRepository,
        );
    const retryBootstrapRunFailedTasksUseCase =
        new retryBootstrapRunFailedTasksUseCaseModule.RetryBootstrapRunFailedTasksUseCase(
            1,
            chainsReadModel,
            bootstrapRepository,
            bootstrapQueueMock,
        );

    app = appModule.createApiApp(
        createBootstrapRunUseCase,
        listBootstrapRunsUseCase,
        getBootstrapRunDetailUseCase,
        getBootstrapStatusUseCase,
        retryBootstrapRunFailedTasksUseCase,
        getDefaultChainUseCase,
        listCollectionsUseCase,
        getCollectionDetailUseCase,
        runtimeHealthUseCase,
        null,
    );
    await app.ready();
});

afterAll(async () => {
    await Promise.all([
        app?.close(),
        fs.rm(dbPath, { force: true }),
        fs.rm(`${dbPath}-shm`, { force: true }),
        fs.rm(`${dbPath}-wal`, { force: true }),
    ]);
});

describe("backend api routes", () => {
    it("returns the default chain", async () => {
        const result = await resolve("GET", "/api/chains/default");
        expect(result.statusCode).toBe(200);
        expect(result.payload.chain.publicChainId).toBe(1);
        expect(result.payload.chain.slug).toBe("ethereum");
    });

    it("reports runtime health with semantic checks", async () => {
        const result = await resolve("GET", "/health/runtime");
        expect(result.statusCode).toBe(200);
        expect(result.payload.ok).toBe(true);
        expect(result.payload.checks).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    key: "backendProcess",
                    status: "pass",
                }),
                expect.objectContaining({ key: "database", status: "pass" }),
                expect.objectContaining({ key: "queue", status: "pass" }),
            ]),
        );
    });

    it("lists collections with cursor pagination", async () => {
        const first = await resolve("GET", "/api/ethereum/collections?limit=1");
        expect(first.statusCode).toBe(200);
        expect(first.payload.page.items).toHaveLength(1);
        expect(first.payload.page.items[0].slug).toBe("milady");
        expect(first.payload.page.nextCursor).toEqual(expect.any(String));

        const second = await resolve(
            "GET",
            `/api/ethereum/collections?limit=1&cursor=${encodeURIComponent(first.payload.page.nextCursor)}`,
        );
        expect(second.statusCode).toBe(200);
        expect(second.payload.page.items).toHaveLength(1);
        expect(second.payload.page.items[0].address).toBe(TERRAFORMS_ADDRESS);
    });

    it("filters collections by status", async () => {
        const result = await resolve(
            "GET",
            "/api/1/collections?status=bootstrapping&limit=10",
        );
        expect(result.statusCode).toBe(200);
        expect(result.payload.page.items).toHaveLength(1);
        expect(result.payload.page.items[0].address).toBe(TERRAFORMS_ADDRESS);
    });

    it("returns collection detail with facets and paged tokens", async () => {
        const result = await resolve("GET", "/api/ethereum/milady?limit=2");
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

    it("supports backward paging with prevCursor", async () => {
        const first = await resolve("GET", "/api/ethereum/milady?limit=1");
        const second = await resolve(
            "GET",
            `/api/ethereum/milady?limit=1&cursor=${encodeURIComponent(first.payload.tokens.nextCursor)}`,
        );
        const third = await resolve(
            "GET",
            `/api/ethereum/milady?limit=1&cursor=${encodeURIComponent(second.payload.tokens.nextCursor)}`,
        );

        expect(second.payload.tokens.prevCursor).toBeNull();
        expect(third.payload.tokens.prevCursor).toEqual(expect.any(String));

        const previousOfThird = await resolve(
            "GET",
            `/api/ethereum/milady?limit=1&cursor=${encodeURIComponent(third.payload.tokens.prevCursor)}`,
        );
        expect(previousOfThird.payload.tokens.items[0].tokenId).toBe("2");
    });

    it("applies AND semantics across different trait keys", async () => {
        const result = await resolve(
            "GET",
            "/api/1/milady?traits=Hat:Beanie,Mood:Calm&limit=10",
        );
        expect(result.statusCode).toBe(200);
        expect(
            result.payload.tokens.items.map(
                (token: { tokenId: string }) => token.tokenId,
            ),
        ).toEqual(["1"]);
    });

    it("applies OR semantics for values within the same trait key", async () => {
        const result = await resolve(
            "GET",
            "/api/1/milady?traits=Hat:Beanie,Hat:Cap&limit=10",
        );
        expect(result.statusCode).toBe(200);
        expect(
            result.payload.tokens.items.map(
                (token: { tokenId: string }) => token.tokenId,
            ),
        ).toEqual(["1", "2", "10"]);
    });

    it("resolves collection by address", async () => {
        const result = await resolve(
            "GET",
            `/api/ethereum/${MILADY_ADDRESS}?limit=10`,
        );
        expect(result.statusCode).toBe(200);
        expect(result.payload.collection.slug).toBe("milady");
    });

    it("creates and reads bootstrap run via secured endpoints", async () => {
        const csrf = await resolve("GET", "/api/security/csrf", undefined, {
            host: "127.0.0.1:3000",
            origin: "http://127.0.0.1:5173",
        });
        expect(csrf.statusCode).toBe(200);
        const token = csrf.payload.token as string;
        const cookie = csrf.headers["set-cookie"] as string;
        expect(token).toHaveLength(32);
        expect(cookie).toContain("artgod_csrf=");

        const create = await resolve(
            "POST",
            "/api/ethereum/collections/bootstrap",
            {
                slug: "terraforms",
                address: TERRAFORMS_ADDRESS,
                standard: "erc721",
                metadataMode: "best_effort",
                supportsEnumerable: true,
            },
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                cookie,
                "x-artgod-csrf": token,
                "content-type": "application/json",
            },
        );
        expect(create.statusCode).toBe(200);
        expect(create.payload.runId).toEqual(expect.any(Number));

        const status = await resolve(
            "GET",
            "/api/ethereum/terraforms/bootstrap",
            undefined,
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:3000",
            },
        );
        expect(status.statusCode).toBe(200);
        expect(status.payload.collection.address).toBe(TERRAFORMS_ADDRESS);
        expect(status.payload.latestRun.runId).toBe(create.payload.runId);
    });

    it("lists bootstrap runs and returns run detail", async () => {
        const runId = insertBootstrapRun({
            chainId: 1,
            collectionAddress: MILADY_ADDRESS,
            status: "completed",
            metadataMode: "best_effort",
            anchorBlock: 24_500_000,
            anchorBlockHash:
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            anchorBlockTimestamp: 1_726_000_000,
        });
        insertBootstrapMetadataTask(runId, "1", "failed_terminal");
        insertBootstrapMetadataTask(runId, "2", "succeeded");

        const list = await resolve(
            "GET",
            "/api/ethereum/bootstrap-runs?limit=10",
        );
        expect(list.statusCode).toBe(200);
        expect(list.payload.page.items.length).toBeGreaterThan(0);
        expect(
            list.payload.page.items.some(
                (item: { run: { runId: number } }) => item.run.runId === runId,
            ),
        ).toBe(true);

        const detail = await resolve(
            "GET",
            `/api/ethereum/bootstrap-runs/${runId}`,
        );
        expect(detail.statusCode).toBe(200);
        expect(detail.payload.run.runId).toBe(runId);
        expect(detail.payload.collection.address).toBe(MILADY_ADDRESS);
        expect(detail.payload.metadataTasks.total).toBe(2);
        expect(detail.payload.failedMetadataTasksPreview).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ status: "failed_terminal" }),
            ]),
        );
    });

    it("retries failed tasks for a specific run", async () => {
        const runId = insertBootstrapRun({
            chainId: 1,
            collectionAddress: MILADY_ADDRESS,
            status: "metadata",
            metadataMode: "strict",
            anchorBlock: 24_500_123,
            anchorBlockHash:
                "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            anchorBlockTimestamp: 1_726_000_123,
        });
        insertBootstrapMetadataTask(runId, "100", "failed_terminal");
        insertBootstrapMetadataTask(runId, "101", "failed_terminal");

        const csrf = await resolve("GET", "/api/security/csrf", undefined, {
            host: "127.0.0.1:3000",
            origin: "http://127.0.0.1:5173",
        });
        const token = csrf.payload.token as string;
        const cookie = csrf.headers["set-cookie"] as string;

        const retried = await resolve(
            "POST",
            `/api/ethereum/bootstrap-runs/${runId}/retry-failed`,
            {},
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                cookie,
                "x-artgod-csrf": token,
                "content-type": "application/json",
            },
        );
        expect(retried.statusCode).toBe(200);
        expect(retried.payload.runId).toBe(runId);
        expect(retried.payload.updatedCount).toBe(2);
        expect(retried.payload.status).toBe("metadata");

        const statuses = db
            .prepare<
                [number]
            >("SELECT status FROM bootstrap_metadata_snapshot_tasks WHERE run_id = ? ORDER BY token_id ASC")
            .all(runId) as Array<{ status: string }>;
        expect(statuses.map((item) => item.status)).toEqual(["retry", "retry"]);
    });

    it("removes legacy collection-scoped bootstrap mutation endpoints", async () => {
        const csrf = await resolve("GET", "/api/security/csrf", undefined, {
            host: "127.0.0.1:3000",
            origin: "http://127.0.0.1:5173",
        });
        const token = csrf.payload.token as string;
        const cookie = csrf.headers["set-cookie"] as string;

        const retryOld = await resolve(
            "POST",
            "/api/ethereum/terraforms/bootstrap/retry-failed",
            {},
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                cookie,
                "x-artgod-csrf": token,
                "content-type": "application/json",
            },
        );
        expect(retryOld.statusCode).toBe(404);

        const restartOld = await resolve(
            "POST",
            "/api/ethereum/terraforms/bootstrap/restart",
            {
                slug: "terraforms",
                address: TERRAFORMS_ADDRESS,
                standard: "erc721",
                metadataMode: "best_effort",
                supportsEnumerable: true,
            },
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                cookie,
                "x-artgod-csrf": token,
                "content-type": "application/json",
            },
        );
        expect(restartOld.statusCode).toBe(404);
    });

    it("rejects bootstrap write requests without csrf token", async () => {
        const response = await resolve(
            "POST",
            "/api/ethereum/collections/bootstrap",
            {
                slug: "terraforms-2",
                address: "0x3333333333333333333333333333333333333333",
                standard: "erc721",
                metadataMode: "best_effort",
                supportsEnumerable: true,
            },
            {
                host: "127.0.0.1:3000",
                origin: "http://127.0.0.1:5173",
                "content-type": "application/json",
            },
        );
        expect(response.statusCode).toBe(403);
        expect(response.payload.error).toBe("forbidden");
    });
});

async function resolve(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS",
    pathWithQuery: string,
    payload?: unknown,
    headers?: Record<string, string>,
): Promise<{
    statusCode: number;
    payload: any;
    headers: Record<string, string | string[] | undefined>;
}> {
    if (!app) {
        throw new Error("Fastify app is not initialized");
    }
    const response = await app.inject({
        method,
        url: pathWithQuery,
        ...(payload === undefined ? {} : { payload: payload as any }),
        ...(headers ? { headers } : {}),
    } as any);
    return {
        statusCode: response.statusCode,
        payload: response.body ? response.json() : null,
        headers: response.headers as Record<
            string,
            string | string[] | undefined
        >,
    };
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
            "(chain_id, slug, address, standard, status, deployment_block, bootstrap_anchor_block, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        1,
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
            "(chain_id, slug, address, standard, status, deployment_block, bootstrap_anchor_block, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
        1,
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

function insertBootstrapRun(input: {
    chainId: number;
    collectionAddress: string;
    status:
        | "requested"
        | "queued"
        | "metadata"
        | "ownership"
        | "backfill"
        | "completed"
        | "failed";
    metadataMode: "strict" | "best_effort";
    anchorBlock: number | null;
    anchorBlockHash: string | null;
    anchorBlockTimestamp: number | null;
}): number {
    const collection = db
        .prepare<
            [number, string]
        >("SELECT collection_id, slug, address FROM collections WHERE chain_id = ? AND lower(address) = ? LIMIT 1")
        .get(input.chainId, input.collectionAddress.toLowerCase()) as
        | { collection_id: number; slug: string | null; address: string }
        | undefined;
    if (!collection) {
        throw new Error("Missing collection for bootstrap run fixture");
    }

    db.prepare(
        "INSERT INTO bootstrap_runs " +
            "(chain_id, collection_id, request_slug, request_address, request_standard, metadata_mode, enumeration_mode, manual_token_ids_json, manual_range_start_token_id, manual_range_total_supply, deployment_block, status, anchor_block, anchor_block_hash, anchor_block_timestamp, error_code, error_message, created_at, updated_at, finished_at) " +
            "VALUES (?, ?, ?, ?, 'erc721', ?, 'enumerable', NULL, NULL, NULL, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)",
    ).run(
        input.chainId,
        collection.collection_id,
        collection.slug ?? "fixture",
        collection.address.toLowerCase(),
        input.metadataMode,
        input.status,
        input.anchorBlock,
        input.anchorBlockHash,
        input.anchorBlockTimestamp,
        "2026-02-01T00:00:00Z",
        "2026-02-01T00:00:00Z",
        input.status === "completed" || input.status === "failed"
            ? "2026-02-01T00:01:00Z"
            : null,
    );

    const row = db
        .prepare<
            [number, number]
        >("SELECT run_id FROM bootstrap_runs WHERE chain_id = ? AND collection_id = ? ORDER BY run_id DESC LIMIT 1")
        .get(input.chainId, collection.collection_id) as
        | { run_id: number }
        | undefined;
    if (!row) {
        throw new Error("Failed to resolve inserted bootstrap run");
    }
    return row.run_id;
}

function insertBootstrapMetadataTask(
    runId: number,
    tokenId: string,
    status: "pending" | "retry" | "succeeded" | "failed_terminal",
): void {
    const run = db
        .prepare<
            [number]
        >("SELECT r.chain_id, r.collection_id, c.address, r.request_standard, r.anchor_block, r.anchor_block_hash, r.anchor_block_timestamp " + "FROM bootstrap_runs r " + "JOIN collections c ON c.chain_id = r.chain_id AND c.collection_id = r.collection_id " + "WHERE r.run_id = ? LIMIT 1")
        .get(runId) as
        | {
              chain_id: number;
              collection_id: number;
              address: string;
              request_standard: string;
              anchor_block: number | null;
              anchor_block_hash: string | null;
              anchor_block_timestamp: number | null;
          }
        | undefined;
    if (
        !run ||
        run.anchor_block === null ||
        !run.anchor_block_hash ||
        run.anchor_block_timestamp === null
    ) {
        throw new Error(
            "Missing run anchor data for metadata task fixture insertion",
        );
    }

    db.prepare(
        "INSERT INTO bootstrap_metadata_snapshot_tasks " +
            "(run_id, chain_id, collection_id, contract_address, token_id, standard, anchor_block, anchor_block_hash, anchor_block_timestamp, status, attempts, next_attempt_at, last_error, last_error_at, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, NULL, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    ).run(
        runId,
        run.chain_id,
        run.collection_id,
        run.address.toLowerCase(),
        tokenId,
        run.request_standard,
        run.anchor_block,
        run.anchor_block_hash,
        run.anchor_block_timestamp,
        status,
    );
}

function insertAttributeKey(key: string): number {
    db.prepare(
        "INSERT INTO attribute_keys (chain_id, contract_address, key) VALUES (?, ?, ?)",
    ).run(1, MILADY_ADDRESS, key);

    const row = db
        .prepare<
            [number, string, string]
        >("SELECT id FROM attribute_keys WHERE chain_id = ? AND contract_address = ? AND key = ?")
        .get(1, MILADY_ADDRESS, key) as { id: number } | undefined;
    if (!row) throw new Error(`Missing attribute key: ${key}`);
    return row.id;
}

function insertAttribute(attributeKeyId: number, value: string): number {
    db.prepare(
        "INSERT INTO attributes (chain_id, contract_address, attribute_key_id, value) VALUES (?, ?, ?, ?)",
    ).run(1, MILADY_ADDRESS, attributeKeyId, value);

    const row = db
        .prepare<
            [number, string, number, string]
        >("SELECT id FROM attributes WHERE chain_id = ? AND contract_address = ? AND attribute_key_id = ? AND value = ?")
        .get(1, MILADY_ADDRESS, attributeKeyId, value) as
        | { id: number }
        | undefined;
    if (!row) throw new Error(`Missing attribute: ${value}`);
    return row.id;
}
