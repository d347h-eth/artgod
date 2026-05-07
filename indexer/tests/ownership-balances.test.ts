import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";

describe("ownership balance persistence", () => {
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
                "DELETE FROM nft_balance_snapshots;",
                "DELETE FROM nft_balances;",
                "DELETE FROM nft_transfer_events;",
                "DELETE FROM transactions;",
                "DELETE FROM blocks;",
                "DELETE FROM collections;",
            ].join("\n"),
        );
    });

    it("normalizes bootstrap owners and removes the seller after the first post-bootstrap transfer", () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const sellerMixedCase =
            "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
        const sellerLower = sellerMixedCase.toLowerCase();
        const buyer = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        const collectionId = insertCollection({
            chainId,
            slug: "terraforms",
            address: contract,
            anchorBlock: 100,
        });

        const bootstrapStorage = new SqliteBootstrapStorage();
        bootstrapStorage.insertSnapshotRows([
            {
                runId: 1,
                chainId,
                collectionId,
                contract,
                tokenId: "5081",
                owner: sellerMixedCase,
                anchorBlock: 100,
            },
        ]);

        expect(
            db.prepare<
                [number],
                { owner: string }
            >(
                "SELECT owner FROM nft_balance_snapshots WHERE run_id = ? LIMIT 1",
            ).get(1)?.owner,
        ).toBe(sellerLower);

        bootstrapStorage.finalizeSnapshot({
            runId: 1,
            chainId,
            collectionId,
            contract,
            anchorBlock: 100,
            anchorHash: `0x${"11".repeat(32)}`,
            anchorTimestamp: 1_726_000_000,
        });

        expect(selectBalanceOwners(chainId, collectionId, "5081")).toEqual([
            { owner: sellerLower, amount: "1" },
        ]);

        const storage = new SqliteStorage();
        const collection = loadCollection(chainId, collectionId);
        storage.persistSyncResult(
            chainId,
            [
                {
                    number: 101,
                    hash: `0x${"22".repeat(32)}`,
                    parentHash: `0x${"11".repeat(32)}`,
                    timestamp: 1_726_000_100,
                },
            ],
            {
                transactions: [],
                collectionScoped: {
                    nftTransferEvents: [
                        {
                            collectionId,
                            contract,
                            from: sellerLower,
                            to: buyer,
                            tokenId: "5081",
                            amount: "1",
                            blockNumber: 101,
                            blockHash: `0x${"22".repeat(32)}`,
                            txHash: `0x${"33".repeat(32)}`,
                            logIndex: 7,
                            kind: "erc721",
                        },
                    ],
                    nftBalanceDeltas: [],
                    fillEvents: [],
                    orderInfos: [],
                    makerTriggers: [],
                    metadataRefreshEvents: [],
                    metadataRefreshRangeEvents: [],
                    collectionExtensionEvents: [],
                },
                global: {
                    cancelEvents: [],
                    makerTriggers: [],
                },
            },
            [collection],
        );

        expect(selectBalanceOwners(chainId, collectionId, "5081")).toEqual([
            { owner: buyer, amount: "1" },
        ]);
    });

    it("keeps bootstrap ownership unchanged for pre-anchor historical backfill", () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const seller = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const priorOwner = "0xcccccccccccccccccccccccccccccccccccccccc";
        const collectionId = insertCollection({
            chainId,
            slug: "terraforms",
            address: contract,
            anchorBlock: 100,
        });

        const bootstrapStorage = new SqliteBootstrapStorage();
        bootstrapStorage.insertSnapshotRows([
            {
                runId: 2,
                chainId,
                collectionId,
                contract,
                tokenId: "5081",
                owner: seller,
                anchorBlock: 100,
            },
        ]);
        bootstrapStorage.finalizeSnapshot({
            runId: 2,
            chainId,
            collectionId,
            contract,
            anchorBlock: 100,
            anchorHash: `0x${"11".repeat(32)}`,
            anchorTimestamp: 1_726_000_000,
        });

        const storage = new SqliteStorage();
        const collection = loadCollection(chainId, collectionId);
        storage.persistSyncResult(
            chainId,
            [
                {
                    number: 99,
                    hash: `0x${"44".repeat(32)}`,
                    parentHash: `0x${"33".repeat(32)}`,
                    timestamp: 1_726_000_099,
                },
            ],
            {
                transactions: [],
                collectionScoped: {
                    nftTransferEvents: [
                        {
                            collectionId,
                            contract,
                            from: priorOwner,
                            to: seller,
                            tokenId: "5081",
                            amount: "1",
                            blockNumber: 99,
                            blockHash: `0x${"44".repeat(32)}`,
                            txHash: `0x${"55".repeat(32)}`,
                            logIndex: 3,
                            kind: "erc721",
                        },
                    ],
                    nftBalanceDeltas: [],
                    fillEvents: [],
                    orderInfos: [],
                    makerTriggers: [],
                    metadataRefreshEvents: [],
                    metadataRefreshRangeEvents: [],
                    collectionExtensionEvents: [],
                },
                global: {
                    cancelEvents: [],
                    makerTriggers: [],
                },
            },
            [collection],
        );

        expect(selectBalanceOwners(chainId, collectionId, "5081")).toEqual([
            { owner: seller, amount: "1" },
        ]);
        expect(selectTransferCount(chainId, collectionId, "5081")).toBe(1);
    });

    it("applies only post-anchor transfers when a backfill range straddles the anchor", () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const seller = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const priorOwner = "0xcccccccccccccccccccccccccccccccccccccccc";
        const buyer = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        const collectionId = insertCollection({
            chainId,
            slug: "terraforms",
            address: contract,
            anchorBlock: 100,
        });

        const bootstrapStorage = new SqliteBootstrapStorage();
        bootstrapStorage.insertSnapshotRows([
            {
                runId: 3,
                chainId,
                collectionId,
                contract,
                tokenId: "5081",
                owner: seller,
                anchorBlock: 100,
            },
        ]);
        bootstrapStorage.finalizeSnapshot({
            runId: 3,
            chainId,
            collectionId,
            contract,
            anchorBlock: 100,
            anchorHash: `0x${"11".repeat(32)}`,
            anchorTimestamp: 1_726_000_000,
        });

        const storage = new SqliteStorage();
        const collection = loadCollection(chainId, collectionId);
        storage.persistSyncResult(
            chainId,
            [
                {
                    number: 99,
                    hash: `0x${"44".repeat(32)}`,
                    parentHash: `0x${"33".repeat(32)}`,
                    timestamp: 1_726_000_099,
                },
                {
                    number: 101,
                    hash: `0x${"66".repeat(32)}`,
                    parentHash: `0x${"44".repeat(32)}`,
                    timestamp: 1_726_000_101,
                },
            ],
            {
                transactions: [],
                collectionScoped: {
                    nftTransferEvents: [
                        {
                            collectionId,
                            contract,
                            from: priorOwner,
                            to: seller,
                            tokenId: "5081",
                            amount: "1",
                            blockNumber: 99,
                            blockHash: `0x${"44".repeat(32)}`,
                            txHash: `0x${"55".repeat(32)}`,
                            logIndex: 3,
                            kind: "erc721",
                        },
                        {
                            collectionId,
                            contract,
                            from: seller,
                            to: buyer,
                            tokenId: "5081",
                            amount: "1",
                            blockNumber: 101,
                            blockHash: `0x${"66".repeat(32)}`,
                            txHash: `0x${"77".repeat(32)}`,
                            logIndex: 4,
                            kind: "erc721",
                        },
                    ],
                    nftBalanceDeltas: [],
                    fillEvents: [],
                    orderInfos: [],
                    makerTriggers: [],
                    metadataRefreshEvents: [],
                    metadataRefreshRangeEvents: [],
                    collectionExtensionEvents: [],
                },
                global: {
                    cancelEvents: [],
                    makerTriggers: [],
                },
            },
            [collection],
        );

        expect(selectBalanceOwners(chainId, collectionId, "5081")).toEqual([
            { owner: buyer, amount: "1" },
        ]);
        expect(selectTransferCount(chainId, collectionId, "5081")).toBe(2);
    });
});

function insertCollection(input: {
    chainId: number;
    slug: string;
    address: string;
    anchorBlock: number;
}): number {
    const result = db
        .prepare<[number, string, string, number]>(
            "INSERT INTO collections " +
                "(chain_id, slug, address, standard, status, token_scope_kind, bootstrap_anchor_block) " +
                "VALUES (?, ?, ?, 'erc721', 'live', 'contract_all_tokens', ?)",
        )
        .run(
            input.chainId,
            input.slug,
            input.address.toLowerCase(),
            input.anchorBlock,
        );

    return Number(result.lastInsertRowid);
}

function loadCollection(chainId: number, collectionId: number) {
    const registry = new SqliteCollectionRegistry();
    const collection = registry.getCollection(chainId, collectionId);
    if (!collection) {
        throw new Error(`Missing collection ${collectionId}`);
    }
    return collection;
}

function selectBalanceOwners(
    chainId: number,
    collectionId: number,
    tokenId: string,
): Array<{ owner: string; amount: string }> {
    return db
        .prepare<[number, number, string], { owner: string; amount: string }>(
            "SELECT owner, amount FROM nft_balances " +
                "WHERE chain_id = ? AND collection_id = ? AND token_id = ? " +
                "ORDER BY owner ASC",
        )
        .all(chainId, collectionId, tokenId) as Array<{
        owner: string;
        amount: string;
    }>;
}

function selectTransferCount(
    chainId: number,
    collectionId: number,
    tokenId: string,
): number {
    return (
        db.prepare<
            [number, number, string],
            { count: number }
        >(
            "SELECT COUNT(*) AS count FROM nft_transfer_events " +
                "WHERE chain_id = ? AND collection_id = ? AND token_id = ?",
        ).get(chainId, collectionId, tokenId)?.count ?? 0
    );
}
