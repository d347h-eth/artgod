import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { BOOTSTRAP_TASK_STATUS } from "@artgod/shared/bootstrap/pipeline";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

// Test-only extension key for generic bootstrap artifact task storage.
const TEST_EXTENSION_KEY = "test-extension";
const TEST_EXTENSION_OWNED_TOKEN_ID = "extension-owned-token";
const TEST_ARTIFACT_LEASE_OWNER_A = "test-artifact-lease-a";
const TEST_ARTIFACT_LEASE_OWNER_B = "test-artifact-lease-b";
const TEST_UNSORTED_TOKEN_IDS = ["1", "10", "2", "100", "0003", "abc"] as const;
const TEST_NUMERIC_TOKEN_ORDER = ["1", "2", "0003", "10", "100", "abc"];

describe("bootstrap storage", () => {
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
                "DELETE FROM bootstrap_collection_extension_artifact_tasks;",
                "DELETE FROM bootstrap_image_cache_tasks;",
                "DELETE FROM token_image_cache;",
                "DELETE FROM token_metadata;",
                "DELETE FROM bootstrap_metadata_snapshot_tasks;",
                "DELETE FROM bootstrap_ownership_snapshot_tasks;",
                "DELETE FROM nft_balance_snapshots;",
            ].join("\n"),
        );
    });

    it("ignores duplicate metadata task inserts for the same run token", () => {
        const storage = new SqliteBootstrapStorage();
        const task = {
            runId: 40,
            chainId: 1,
            collectionId: 7,
            contract: "0xAbCd000000000000000000000000000000000000",
            tokenId: "5081",
            standard: COLLECTION_STANDARD.Erc721,
            anchorBlock: 100,
            anchorHash: `0x${"11".repeat(32)}`,
            anchorTimestamp: 1_726_000_000,
        };

        expect(storage.insertMetadataTasks([task])).toBe(1);
        expect(storage.insertMetadataTasks([task])).toBe(0);
        expect(storage.getMetadataTaskCounts(40)).toEqual({
            pending: 1,
            retry: 0,
            succeeded: 0,
            failedTerminal: 0,
            total: 1,
        });
    });

    it("lists bootstrap token tasks in numeric token-id order", () => {
        const storage = new SqliteBootstrapStorage();
        storage.insertMetadataTasks(
            TEST_UNSORTED_TOKEN_IDS.map((tokenId) =>
                buildMetadataTaskSeed({ runId: 901, tokenId }),
            ),
        );

        expect(
            storage
                .listMetadataTasksDueNow(901, 0, 10)
                .map((task) => task.tokenId),
        ).toEqual(TEST_NUMERIC_TOKEN_ORDER);
        expect(storage.listMetadataTaskTokenIds(901)).toEqual(
            TEST_NUMERIC_TOKEN_ORDER,
        );

        for (const tokenId of TEST_UNSORTED_TOKEN_IDS) {
            seedMetadataWithImage(storage, {
                runId: 902,
                tokenId,
                image: `ipfs://image-${tokenId}`,
            });
        }
        storage.seedImageCacheTasks({
            runId: 902,
            requestedMaxDimension: 512,
        });
        expect(
            storage
                .listImageCacheTasksDueNow(902, 0, 10)
                .map((task) => task.tokenId),
        ).toEqual(TEST_NUMERIC_TOKEN_ORDER);

        storage.insertOwnershipTasks(
            TEST_UNSORTED_TOKEN_IDS.map((tokenId) =>
                buildMetadataTaskSeed({ runId: 903, tokenId }),
            ),
        );
        expect(
            storage
                .listOwnershipTasksDueNow(903, 0, 10)
                .map((task) => task.tokenId),
        ).toEqual(TEST_NUMERIC_TOKEN_ORDER);

        for (const tokenId of TEST_UNSORTED_TOKEN_IDS) {
            seedCollectionExtensionArtifactTask(storage, {
                runId: 904,
                tokenId,
            });
        }
        expect(
            storage
                .listCollectionExtensionArtifactTasksDueNow(904, 0, 10)
                .map((task) => task.tokenId),
        ).toEqual(TEST_NUMERIC_TOKEN_ORDER);
    });

    it("seeds image cache tasks from successful metadata tasks", () => {
        const storage = new SqliteBootstrapStorage();
        storage.insertMetadataTasks([
            {
                runId: 42,
                chainId: 1,
                collectionId: 7,
                contract: "0xAbCd000000000000000000000000000000000000",
                tokenId: "5081",
                standard: COLLECTION_STANDARD.Erc721,
                anchorBlock: 100,
                anchorHash: `0x${"11".repeat(32)}`,
                anchorTimestamp: 1_726_000_000,
            },
        ]);
        storage.markMetadataTaskSucceeded(42, "5081", 1);
        db.prepare(
            "INSERT INTO token_metadata " +
                "(chain_id, collection_id, contract_address, token_id, uri, image, attributes_json) " +
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
            1,
            7,
            "0xabcd000000000000000000000000000000000000",
            "5081",
            "ipfs://metadata",
            "ipfs://image",
            "[]",
        );

        expect(
            storage.seedImageCacheTasks({
                runId: 42,
                requestedMaxDimension: 512,
            }),
        ).toBe(1);

        const due = storage.listImageCacheTasksDueNow(42, Date.now(), 10);
        expect(due).toEqual([
            expect.objectContaining({
                runId: 42,
                chainId: 1,
                collectionId: 7,
                contract: "0xabcd000000000000000000000000000000000000",
                tokenId: "5081",
                sourceImageUrl: "ipfs://image",
                requestedMaxDimension: 512,
                status: BOOTSTRAP_TASK_STATUS.Pending,
            }),
        ]);
        expect(storage.getImageCacheTaskCounts(42)).toEqual({
            pending: 1,
            retry: 0,
            succeeded: 0,
            failedTerminal: 0,
            total: 1,
        });

        expect(
            storage.markImageCacheTaskSucceeded({
                runId: 42,
                tokenId: "5081",
                attempts: 1,
                cacheKey: "cache",
                contentType: "image/webp",
                sourceBytes: 100,
                cachedBytes: 40,
                width: 512,
                height: 512,
                relativePath: "1/7/5081/cache.webp",
                publicPath: "/media/token-images/1/7/5081/cache.webp",
            }),
        ).toBe(true);

        expect(storage.getImageCacheTaskCounts(42)).toEqual({
            pending: 0,
            retry: 0,
            succeeded: 1,
            failedTerminal: 0,
            total: 1,
        });
    });

    it("seeds collection-extension artifact tasks from metadata and extension-owned rows together", () => {
        const storage = new SqliteBootstrapStorage();
        storage.insertMetadataTasks([
            {
                runId: 43,
                chainId: 1,
                collectionId: 7,
                contract: "0xAbCd000000000000000000000000000000000000",
                tokenId: "5081",
                standard: COLLECTION_STANDARD.Erc721,
                anchorBlock: 100,
                anchorHash: `0x${"11".repeat(32)}`,
                anchorTimestamp: 1_726_000_000,
            },
        ]);
        storage.markMetadataTaskSucceeded(43, "5081", 1);

        expect(
            storage.seedCollectionExtensionArtifactTasks({
                runId: 43,
                extensionKey: TEST_EXTENSION_KEY,
                extensionOwnedTasks: [
                    {
                        runId: 43,
                        chainId: 1,
                        collectionId: 7,
                        contract: "0xAbCd000000000000000000000000000000000000",
                        tokenId: TEST_EXTENSION_OWNED_TOKEN_ID,
                        extensionKey: TEST_EXTENSION_KEY,
                    },
                ],
            }),
        ).toBe(1);

        expect(storage.getCollectionExtensionArtifactTaskCounts(43)).toEqual({
            pending: 2,
            retry: 0,
            succeeded: 0,
            failedTerminal: 0,
            total: 2,
        });
        expect(
            storage
                .listCollectionExtensionArtifactTasksDueNow(43, Date.now(), 10)
                .map((task) => task.tokenId),
        ).toEqual(["5081", TEST_EXTENSION_OWNED_TOKEN_ID]);
    });

    it("claims collection-extension artifact tasks with a lease fence", () => {
        const storage = new SqliteBootstrapStorage();
        seedCollectionExtensionArtifactTask(storage, {
            runId: 44,
            tokenId: "1",
        });

        expect(
            storage
                .listCollectionExtensionArtifactTasksToPublish(
                    44,
                    null,
                    1_000,
                    10,
                )
                .map((task) => task.tokenId),
        ).toEqual(["1"]);

        const firstClaim = storage.claimCollectionExtensionArtifactTask({
            runId: 44,
            tokenId: "1",
            extensionKey: TEST_EXTENSION_KEY,
            nowMs: 1_000,
            leaseOwner: TEST_ARTIFACT_LEASE_OWNER_A,
            leaseUntil: 2_000,
        });

        expect(firstClaim).toEqual(
            expect.objectContaining({
                tokenId: "1",
                attempts: 1,
                leaseOwner: TEST_ARTIFACT_LEASE_OWNER_A,
                leaseUntil: 2_000,
            }),
        );
        expect(
            storage.listCollectionExtensionArtifactTasksToPublish(
                44,
                null,
                1_500,
                10,
            ),
        ).toEqual([]);
        expect(
            storage.claimCollectionExtensionArtifactTask({
                runId: 44,
                tokenId: "1",
                extensionKey: TEST_EXTENSION_KEY,
                nowMs: 1_500,
                leaseOwner: TEST_ARTIFACT_LEASE_OWNER_B,
                leaseUntil: 2_500,
            }),
        ).toBeNull();

        expect(
            storage.renewCollectionExtensionArtifactTaskLease({
                runId: 44,
                tokenId: "1",
                extensionKey: TEST_EXTENSION_KEY,
                leaseOwner: TEST_ARTIFACT_LEASE_OWNER_A,
                leaseUntil: 3_000,
            }),
        ).toBe(true);
        expect(
            storage.getCollectionExtensionArtifactTask({
                runId: 44,
                tokenId: "1",
                extensionKey: TEST_EXTENSION_KEY,
            }),
        ).toEqual(
            expect.objectContaining({
                leaseOwner: TEST_ARTIFACT_LEASE_OWNER_A,
                leaseUntil: 3_000,
            }),
        );
    });

    it("reclaims collection-extension artifact tasks after lease expiry", () => {
        const storage = new SqliteBootstrapStorage();
        seedCollectionExtensionArtifactTask(storage, {
            runId: 45,
            tokenId: "1",
        });

        const staleClaim = storage.claimCollectionExtensionArtifactTask({
            runId: 45,
            tokenId: "1",
            extensionKey: TEST_EXTENSION_KEY,
            nowMs: 1_000,
            leaseOwner: TEST_ARTIFACT_LEASE_OWNER_A,
            leaseUntil: 1_500,
        });
        const reclaimed = storage.claimCollectionExtensionArtifactTask({
            runId: 45,
            tokenId: "1",
            extensionKey: TEST_EXTENSION_KEY,
            nowMs: 1_501,
            leaseOwner: TEST_ARTIFACT_LEASE_OWNER_B,
            leaseUntil: 2_500,
        });

        expect(staleClaim).toEqual(expect.objectContaining({ attempts: 1 }));
        expect(reclaimed).toEqual(
            expect.objectContaining({
                attempts: 2,
                leaseOwner: TEST_ARTIFACT_LEASE_OWNER_B,
            }),
        );
        expect(
            storage.markCollectionExtensionArtifactTaskSucceeded({
                runId: 45,
                tokenId: "1",
                extensionKey: TEST_EXTENSION_KEY,
                leaseOwner: TEST_ARTIFACT_LEASE_OWNER_A,
                attempts: 1,
            }),
        ).toBe(false);
        expect(
            storage.markCollectionExtensionArtifactTaskSucceeded({
                runId: 45,
                tokenId: "1",
                extensionKey: TEST_EXTENSION_KEY,
                leaseOwner: TEST_ARTIFACT_LEASE_OWNER_B,
                attempts: 2,
            }),
        ).toBe(true);
        expect(storage.getCollectionExtensionArtifactTaskCounts(45)).toEqual({
            pending: 0,
            retry: 0,
            succeeded: 1,
            failedTerminal: 0,
            total: 1,
        });
    });

    it("does not let stale collection-extension artifact settlements regress terminal state", () => {
        const storage = new SqliteBootstrapStorage();
        seedCollectionExtensionArtifactTask(storage, {
            runId: 46,
            tokenId: "1",
        });
        seedCollectionExtensionArtifactTask(storage, {
            runId: 46,
            tokenId: "2",
        });

        storage.claimCollectionExtensionArtifactTask({
            runId: 46,
            tokenId: "1",
            extensionKey: TEST_EXTENSION_KEY,
            nowMs: 1_000,
            leaseOwner: TEST_ARTIFACT_LEASE_OWNER_A,
            leaseUntil: 2_000,
        });
        expect(
            storage.markCollectionExtensionArtifactTaskSucceeded({
                runId: 46,
                tokenId: "1",
                extensionKey: TEST_EXTENSION_KEY,
                leaseOwner: TEST_ARTIFACT_LEASE_OWNER_A,
                attempts: 1,
            }),
        ).toBe(true);
        expect(
            storage.markCollectionExtensionArtifactTaskRetry({
                runId: 46,
                tokenId: "1",
                extensionKey: TEST_EXTENSION_KEY,
                leaseOwner: TEST_ARTIFACT_LEASE_OWNER_A,
                attempts: 1,
                nextAttemptAt: 0,
                lastError: "stale failure",
                failedTerminal: true,
            }),
        ).toBe(false);

        storage.claimCollectionExtensionArtifactTask({
            runId: 46,
            tokenId: "2",
            extensionKey: TEST_EXTENSION_KEY,
            nowMs: 1_000,
            leaseOwner: TEST_ARTIFACT_LEASE_OWNER_B,
            leaseUntil: 2_000,
        });
        expect(
            storage.markCollectionExtensionArtifactTaskRetry({
                runId: 46,
                tokenId: "2",
                extensionKey: TEST_EXTENSION_KEY,
                leaseOwner: TEST_ARTIFACT_LEASE_OWNER_B,
                attempts: 1,
                nextAttemptAt: 0,
                lastError: "terminal failure",
                failedTerminal: true,
            }),
        ).toBe(true);
        expect(
            storage.markCollectionExtensionArtifactTaskSucceeded({
                runId: 46,
                tokenId: "2",
                extensionKey: TEST_EXTENSION_KEY,
                leaseOwner: TEST_ARTIFACT_LEASE_OWNER_B,
                attempts: 1,
            }),
        ).toBe(false);
        expect(storage.getCollectionExtensionArtifactTaskCounts(46)).toEqual({
            pending: 0,
            retry: 0,
            succeeded: 1,
            failedTerminal: 1,
            total: 2,
        });
    });

    it("publishes retry collection-extension artifact tasks only when due", () => {
        const storage = new SqliteBootstrapStorage();
        seedCollectionExtensionArtifactTask(storage, {
            runId: 47,
            tokenId: "1",
        });
        storage.claimCollectionExtensionArtifactTask({
            runId: 47,
            tokenId: "1",
            extensionKey: TEST_EXTENSION_KEY,
            nowMs: 1_000,
            leaseOwner: TEST_ARTIFACT_LEASE_OWNER_A,
            leaseUntil: 2_000,
        });
        expect(
            storage.markCollectionExtensionArtifactTaskRetry({
                runId: 47,
                tokenId: "1",
                extensionKey: TEST_EXTENSION_KEY,
                leaseOwner: TEST_ARTIFACT_LEASE_OWNER_A,
                attempts: 1,
                nextAttemptAt: 5_000,
                lastError: "temporary failure",
                failedTerminal: false,
            }),
        ).toBe(true);

        expect(
            storage.listCollectionExtensionArtifactTasksToPublish(
                47,
                null,
                4_999,
                10,
            ),
        ).toEqual([]);
        expect(
            storage
                .listCollectionExtensionArtifactTasksToPublish(
                    47,
                    null,
                    5_000,
                    10,
                )
                .map((task) => task.tokenId),
        ).toEqual(["1"]);
    });

    it("tracks ownership task retries and writes idempotent snapshot rows", () => {
        const storage = new SqliteBootstrapStorage();
        storage.insertOwnershipTasks([
            {
                runId: 77,
                chainId: 1,
                collectionId: 9,
                contract: "0xAbCd000000000000000000000000000000000000",
                tokenId: "1074",
                standard: COLLECTION_STANDARD.Erc721,
                anchorBlock: 200,
                anchorHash: `0x${"22".repeat(32)}`,
                anchorTimestamp: 1_726_000_123,
            },
        ]);

        expect(storage.listOwnershipTasksDueNow(77, Date.now(), 10)).toEqual([
            expect.objectContaining({
                runId: 77,
                chainId: 1,
                collectionId: 9,
                contract: "0xabcd000000000000000000000000000000000000",
                tokenId: "1074",
                status: BOOTSTRAP_TASK_STATUS.Pending,
            }),
        ]);

        storage.markOwnershipTaskRetry({
            runId: 77,
            tokenId: "1074",
            attempts: 1,
            nextAttemptAt: 0,
            lastError: "temporary rpc failure",
            failedTerminal: false,
        });
        expect(storage.getOwnershipTaskCounts(77)).toEqual({
            pending: 0,
            retry: 1,
            succeeded: 0,
            failedTerminal: 0,
            total: 1,
        });

        storage.markOwnershipTaskSucceeded({
            runId: 77,
            tokenId: "1074",
            attempts: 2,
            owner: "0x1111111111111111111111111111111111111111",
        });
        storage.markOwnershipTaskSucceeded({
            runId: 77,
            tokenId: "1074",
            attempts: 3,
            owner: "0x2222222222222222222222222222222222222222",
        });

        expect(storage.getOwnershipTaskCounts(77)).toEqual({
            pending: 0,
            retry: 0,
            succeeded: 1,
            failedTerminal: 0,
            total: 1,
        });
        const rows = db
            .prepare<
                [number, string]
            >("SELECT owner FROM nft_balance_snapshots WHERE run_id = ? AND token_id = ?")
            .all(77, "1074") as Array<{ owner: string }>;
        expect(rows).toEqual([
            { owner: "0x2222222222222222222222222222222222222222" },
        ]);

        storage.deleteRunTemporaryData(77);
        expect(storage.getOwnershipTaskCounts(77)).toEqual({
            pending: 0,
            retry: 0,
            succeeded: 0,
            failedTerminal: 0,
            total: 0,
        });
        const snapshotCount = db
            .prepare<
                [number]
            >("SELECT COUNT(*) AS count FROM nft_balance_snapshots WHERE run_id = ?")
            .get(77) as { count: number } | undefined;
        expect(snapshotCount?.count ?? 0).toBe(0);
    });

    it("deletes only successful image-cache task rows", () => {
        const storage = new SqliteBootstrapStorage();
        seedMetadataWithImage(storage, {
            runId: 88,
            tokenId: "1",
            image: "ipfs://image-1",
        });
        seedMetadataWithImage(storage, {
            runId: 88,
            tokenId: "2",
            image: "ipfs://image-2",
        });
        storage.seedImageCacheTasks({
            runId: 88,
            requestedMaxDimension: 512,
        });

        expect(
            storage.markImageCacheTaskSucceeded({
                runId: 88,
                tokenId: "1",
                attempts: 1,
                cacheKey: "cache-1",
                contentType: "image/webp",
                sourceBytes: 100,
                cachedBytes: 40,
                width: 512,
                height: 512,
                relativePath: "1/7/1/cache.webp",
                publicPath: "/media/token-images/1/7/1/cache.webp",
            }),
        ).toBe(true);
        storage.markImageCacheTaskRetry({
            runId: 88,
            tokenId: "2",
            attempts: 5,
            nextAttemptAt: 0,
            lastError: "slow origin",
            failedTerminal: true,
        });

        expect(storage.deleteSucceededImageCacheTasks(88)).toBe(1);
        expect(storage.getImageCacheTaskCounts(88)).toEqual({
            pending: 0,
            retry: 0,
            succeeded: 0,
            failedTerminal: 1,
            total: 1,
        });
    });

    it("does not settle image-cache tasks that were purged mid-flight", () => {
        const storage = new SqliteBootstrapStorage();
        seedMetadataWithImage(storage, {
            runId: 90,
            tokenId: "1",
            image: "ipfs://image-1",
        });
        storage.seedImageCacheTasks({
            runId: 90,
            requestedMaxDimension: 512,
        });
        storage.resetImageCacheTasks(90);

        expect(
            storage.markImageCacheTaskSucceeded({
                runId: 90,
                tokenId: "1",
                attempts: 1,
                cacheKey: "cache-1",
                contentType: "image/webp",
                sourceBytes: 100,
                cachedBytes: 40,
                width: 512,
                height: 512,
                relativePath: "1/7/1/cache.webp",
                publicPath: "/media/token-images/1/7/1/cache.webp",
            }),
        ).toBe(false);
        expect(countTokenImageCacheRows()).toBe(0);
    });
});

function seedCollectionExtensionArtifactTask(
    storage: SqliteBootstrapStorage,
    input: { runId: number; tokenId: string },
): void {
    storage.seedCollectionExtensionArtifactTasks({
        runId: input.runId,
        extensionKey: TEST_EXTENSION_KEY,
        extensionOwnedTasks: [
            {
                runId: input.runId,
                chainId: 1,
                collectionId: 7,
                contract: "0xAbCd000000000000000000000000000000000000",
                tokenId: input.tokenId,
                extensionKey: TEST_EXTENSION_KEY,
            },
        ],
    });
}

function seedMetadataWithImage(
    storage: SqliteBootstrapStorage,
    input: {
        runId: number;
        tokenId: string;
        image: string;
    },
): void {
    storage.insertMetadataTasks([buildMetadataTaskSeed(input)]);
    storage.markMetadataTaskSucceeded(input.runId, input.tokenId, 1);
    db.prepare(
        "INSERT INTO token_metadata " +
            "(chain_id, collection_id, contract_address, token_id, uri, image, attributes_json) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
        1,
        7,
        "0xabcd000000000000000000000000000000000000",
        input.tokenId,
        `ipfs://metadata-${input.tokenId}`,
        input.image,
        "[]",
    );
}

function buildMetadataTaskSeed(input: { runId: number; tokenId: string }) {
    return {
        runId: input.runId,
        chainId: 1,
        collectionId: 7,
        contract: "0xAbCd000000000000000000000000000000000000",
        tokenId: input.tokenId,
        standard: COLLECTION_STANDARD.Erc721,
        anchorBlock: 100,
        anchorHash: `0x${"11".repeat(32)}`,
        anchorTimestamp: 1_726_000_000,
    };
}

function countTokenImageCacheRows(): number {
    const row = db
        .prepare("SELECT COUNT(1) AS count FROM token_image_cache")
        .get() as { count: number } | undefined;
    return row?.count ?? 0;
}
