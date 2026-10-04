import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import { SqliteStorage } from "../src/infra/storage/sqlite.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import type { NftTransferEvent, OnChainData } from "../src/domain/onchain.js";

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
                "DELETE FROM collection_sync_blocks;",
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
        const sellerMixedCase = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
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
            db
                .prepare<
                    [number],
                    { owner: string }
                >("SELECT owner FROM nft_balance_snapshots WHERE run_id = ? LIMIT 1")
                .get(1)?.owner,
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
                    nftApprovalEvents: [],
                    nftBalanceDeltas: [],
                    fillEvents: [],
                    orderInfos: [],
                    makerTriggers: [],
                    metadataRefreshEvents: [],
                    metadataRefreshRangeEvents: [],
                    collectionExtensionEvents: [],
                    collectionExtensionEventMedia: [],
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

    it.each([
        {
            name: "older blocks",
            firstBlock: 103,
            firstLog: 1,
            lateBlock: 101,
            lateLog: 1,
        },
        {
            name: "earlier logs in the same block",
            firstBlock: 103,
            firstLog: 7,
            lateBlock: 103,
            lateLog: 1,
        },
    ])(
        "keeps the latest ERC721 owner when repairing $name",
        ({ firstBlock, firstLog, lateBlock, lateLog }) => {
            const { collectionId, storage, transfer, persist } =
                transferFixture();
            const firstOwner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            const middleOwner = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
            const latestOwner = "0xcccccccccccccccccccccccccccccccccccccccc";
            const latest = transfer(
                firstBlock,
                firstLog,
                middleOwner,
                latestOwner,
            );
            const late = transfer(lateBlock, lateLog, firstOwner, middleOwner);
            persist([latest]);
            persist([late]);
            persist([late, latest]);
            expect(selectBalanceOwners(1, collectionId, "1")).toEqual([
                { owner: latestOwner, amount: "1" },
            ]);
            expect(selectTransferCount(1, collectionId, "1")).toBe(2);
            expect(
                db
                    .prepare(
                        "SELECT last_block_number, last_log_index FROM nft_balances WHERE collection_id = ?",
                    )
                    .get(collectionId),
            ).toEqual({
                last_block_number: firstBlock,
                last_log_index: firstLog,
            });
            storage.rollbackFromBlock(1, firstBlock);
            expect(
                storage.countCollectionSyncedBlocksInRange(
                    1,
                    collectionId,
                    firstBlock,
                    firstBlock,
                ),
            ).toBe(0);
        },
    );

    it("does not resurrect a burned ERC721 when an older gap is repaired", () => {
        const { collectionId, transfer, persist } = transferFixture();
        const seller = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const buyer = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        persist([
            transfer(
                103,
                1,
                buyer,
                "0x0000000000000000000000000000000000000000",
            ),
        ]);
        persist([transfer(101, 1, seller, buyer)]);
        expect(selectBalanceOwners(1, collectionId, "1")).toEqual([]);
        expect(selectTransferCount(1, collectionId, "1")).toBe(2);
    });

    it("preserves transfer senders and reverses ERC721 burns, transfers, and mints", () => {
        const { collectionId, storage, transfer, persist } = transferFixture();
        const zero = "0x0000000000000000000000000000000000000000";
        const seller = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const buyer = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        persist([
            transfer(101, 1, zero, seller),
            transfer(102, 1, seller, buyer),
            transfer(103, 1, buyer, zero),
        ]);

        expect(selectBalanceOwners(1, collectionId, "1")).toEqual([]);
        expect(
            db
                .prepare<
                    [number, number]
                >("SELECT from_address, to_address FROM nft_transfer_events " + "WHERE chain_id = ? AND collection_id = ? " + "ORDER BY block_number ASC, log_index ASC")
                .all(1, collectionId),
        ).toEqual([
            { from_address: zero, to_address: seller },
            { from_address: seller, to_address: buyer },
            { from_address: buyer, to_address: zero },
        ]);

        storage.rollbackFromBlock(1, 103);
        expect(selectBalanceOwners(1, collectionId, "1")).toEqual([
            { owner: buyer, amount: "1" },
        ]);
        storage.rollbackFromBlock(1, 102);
        expect(selectBalanceOwners(1, collectionId, "1")).toEqual([
            { owner: seller, amount: "1" },
        ]);
        storage.rollbackFromBlock(1, 101);
        expect(selectBalanceOwners(1, collectionId, "1")).toEqual([]);
    });

    it("projects the latest transfer even when logs in one repaired range are unordered", () => {
        const { collectionId, transfer, persist } = transferFixture();
        const seller = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const middle = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        const buyer = "0xcccccccccccccccccccccccccccccccccccccccc";
        persist([
            transfer(103, 2, middle, buyer),
            transfer(101, 1, seller, middle),
        ]);
        expect(selectBalanceOwners(1, collectionId, "1")).toEqual([
            { owner: buyer, amount: "1" },
        ]);
    });

    it("converges ERC1155 deltas after late repair without applying duplicates", () => {
        const { collectionId, transfer, persist } = transferFixture();
        db.prepare(
            "UPDATE collections SET standard = ? WHERE collection_id = ?",
        ).run(COLLECTION_STANDARD.Erc1155, collectionId);
        const zero = "0x0000000000000000000000000000000000000000";
        const seller = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const buyer = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        const sent = {
            ...transfer(103, 1, seller, buyer),
            kind: COLLECTION_STANDARD.Erc1155,
            amount: "2",
        };
        const minted = {
            ...transfer(101, 1, zero, seller),
            kind: COLLECTION_STANDARD.Erc1155,
            amount: "5",
        };
        persist([sent]);
        persist([minted]);
        persist([sent, minted]);
        expect(selectBalanceOwners(1, collectionId, "1")).toEqual([
            { owner: seller, amount: "3" },
            { owner: buyer, amount: "2" },
        ]);
    });

    it("records collection-specific block sync coverage for the targeted collections", () => {
        const chainId = 1;
        const contract = "0xabc0000000000000000000000000000000000000";
        const collectionId = insertCollection({
            chainId,
            slug: "terraforms",
            address: contract,
            anchorBlock: 100,
        });
        const untouchedCollectionId = insertCollection({
            chainId,
            slug: "milady",
            address: "0xdef0000000000000000000000000000000000000",
            anchorBlock: 100,
        });

        const storage = new SqliteStorage();
        const collection = loadCollection(chainId, collectionId);
        const blocks = [
            {
                number: 101,
                hash: `0x${"22".repeat(32)}`,
                parentHash: `0x${"11".repeat(32)}`,
                timestamp: 1_726_000_100,
            },
            {
                number: 102,
                hash: `0x${"33".repeat(32)}`,
                parentHash: `0x${"22".repeat(32)}`,
                timestamp: 1_726_000_101,
            },
        ];

        storage.persistSyncResult(chainId, blocks, emptyOnChainData(), [
            collection,
        ]);
        storage.persistSyncResult(chainId, blocks, emptyOnChainData(), [
            collection,
        ]);

        expect(storage.countBlocksInRange(chainId, 101, 102)).toBe(2);
        expect(
            storage.countCollectionSyncedBlocksInRange(
                chainId,
                collectionId,
                101,
                102,
            ),
        ).toBe(2);
        expect(
            storage.countCollectionSyncedBlocksInRange(
                chainId,
                untouchedCollectionId,
                101,
                102,
            ),
        ).toBe(0);

        storage.rollbackFromBlock(chainId, 102);

        expect(storage.countBlocksInRange(chainId, 101, 102)).toBe(1);
        expect(
            storage.countCollectionSyncedBlocksInRange(
                chainId,
                collectionId,
                101,
                102,
            ),
        ).toBe(1);
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
                    nftApprovalEvents: [],
                    nftBalanceDeltas: [],
                    fillEvents: [],
                    orderInfos: [],
                    makerTriggers: [],
                    metadataRefreshEvents: [],
                    metadataRefreshRangeEvents: [],
                    collectionExtensionEvents: [],
                    collectionExtensionEventMedia: [],
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
                    nftApprovalEvents: [],
                    nftBalanceDeltas: [],
                    fillEvents: [],
                    orderInfos: [],
                    makerTriggers: [],
                    metadataRefreshEvents: [],
                    metadataRefreshRangeEvents: [],
                    collectionExtensionEvents: [],
                    collectionExtensionEventMedia: [],
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
        .prepare<
            [number, string, string, number]
        >("INSERT INTO collections " + "(chain_id, slug, address, standard, status, token_scope_kind, bootstrap_anchor_block) " + "VALUES (?, ?, ?, 'erc721', 'live', 'contract_all_tokens', ?)")
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
        .prepare<
            [number, number, string],
            { owner: string; amount: string }
        >("SELECT owner, amount FROM nft_balances " + "WHERE chain_id = ? AND collection_id = ? AND token_id = ? " + "ORDER BY owner ASC")
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
        db
            .prepare<
                [number, number, string],
                { count: number }
            >("SELECT COUNT(*) AS count FROM nft_transfer_events " + "WHERE chain_id = ? AND collection_id = ? AND token_id = ?")
            .get(chainId, collectionId, tokenId)?.count ?? 0
    );
}

function transferFixture() {
    const contract = "0xabc0000000000000000000000000000000000000";
    const collectionId = insertCollection({
        chainId: 1,
        slug: "gap-repair",
        address: contract,
        anchorBlock: 100,
    });
    const storage = new SqliteStorage();
    const transfer = (
        blockNumber: number,
        logIndex: number,
        from: string,
        to: string,
    ): NftTransferEvent => ({
        collectionId,
        contract,
        tokenId: "1",
        from,
        to,
        amount: "1",
        blockNumber,
        logIndex,
        blockHash: `0x${String(blockNumber).padStart(64, "0")}`,
        txHash: `0x${String(blockNumber * 100 + logIndex).padStart(64, "0")}`,
        kind: COLLECTION_STANDARD.Erc721,
    });
    const persist = (events: NftTransferEvent[]) => {
        const data = emptyOnChainData();
        data.collectionScoped.nftTransferEvents = events;
        storage.persistSyncResult(
            1,
            events.map((event) => ({
                number: event.blockNumber,
                hash: event.blockHash,
                parentHash: `0x${"00".repeat(32)}`,
                timestamp: event.blockNumber,
            })),
            data,
            [loadCollection(1, collectionId)],
        );
    };
    return { collectionId, storage, transfer, persist };
}

function emptyOnChainData(): OnChainData {
    return {
        transactions: [],
        collectionScoped: {
            nftTransferEvents: [],
            nftApprovalEvents: [],
            nftBalanceDeltas: [],
            fillEvents: [],
            orderInfos: [],
            makerTriggers: [],
            metadataRefreshEvents: [],
            metadataRefreshRangeEvents: [],
            collectionExtensionEvents: [],
            collectionExtensionEventMedia: [],
        },
        global: {
            cancelEvents: [],
            makerTriggers: [],
        },
    };
}
