import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import { finalizeBootstrapSnapshotFixture } from "./helpers/bootstrap-snapshot-fixture.js";
import {
    insertCollection,
    selectBalanceOwners,
    selectTransferCount,
    transferFixture,
    emptyOnChainData,
} from "./helpers/ownership-fixture.js";
import { commitRollbackFixture } from "./helpers/rollback-fixture.js";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { db, setDbPath } from "@artgod/shared/database";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";

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
                "DELETE FROM blocks; DELETE FROM chain_sync_progress; DELETE FROM chain_head_samples; DELETE FROM chain_sync_targets;",
                "DELETE FROM collections;",
            ].join("\n"),
        );
    });

    it("normalizes bootstrap owners and applies the first accepted post-base transfer", () => {
        const f = transferFixture();
        const seller = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";
        const buyer = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        const bootstrap = new SqliteBootstrapStorage();
        bootstrap.insertSnapshotRows([
            {
                runId: 1,
                chainId: 1,
                collectionId: f.collectionId,
                contract: f.contract,
                tokenId: "1",
                owner: seller,
                anchorBlock: 100,
            },
        ]);
        finalizeBootstrapSnapshotFixture(bootstrap, {
            runId: 1,
            chainId: 1,
            collectionId: f.collectionId,
            contract: f.contract,
            anchorBlock: 100,
            anchorHash: block(100).hash,
            anchorTimestamp: 100,
        });
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: seller.toLowerCase(), amount: "1" },
        ]);
        f.persist([f.transfer(101, 1, seller.toLowerCase(), buyer)]);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
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
            commitRollbackFixture({
                storage: storage,
                chainId: 1,
                fromBlock: firstBlock,
                owners: [
                    {
                        collectionId,
                        tokenId: "1",
                        owner:
                            lateBlock < firstBlock ? middleOwner : firstOwner,
                    },
                ],
            });
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

        commitRollbackFixture({
            storage: storage,
            chainId: 1,
            fromBlock: 103,
            owners: [{ collectionId, tokenId: "1", owner: buyer }],
        });
        expect(selectBalanceOwners(1, collectionId, "1")).toEqual([
            { owner: buyer, amount: "1" },
        ]);
        commitRollbackFixture({
            storage: storage,
            chainId: 1,
            fromBlock: 102,
            owners: [{ collectionId, tokenId: "1", owner: seller }],
        });
        expect(selectBalanceOwners(1, collectionId, "1")).toEqual([
            { owner: seller, amount: "1" },
        ]);
        commitRollbackFixture({
            storage: storage,
            chainId: 1,
            fromBlock: 101,
            owners: [{ collectionId, tokenId: "1", owner: null }],
        });
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

    it("applies all ERC1155 deltas once and historical replay cannot apply them again", () => {
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
        persist([sent, minted]);
        persist([minted]);
        persist([sent, minted]);
        expect(selectBalanceOwners(1, collectionId, "1")).toEqual([
            { owner: seller, amount: "3" },
            { owner: buyer, amount: "2" },
        ]);
    });

    it("records scoped coverage only for applied targeted collections", () => {
        const f = transferFixture();
        const untouched = insertCollection({
            chainId: 1,
            slug: "untouched",
            address: "0xdef0000000000000000000000000000000000000",
            anchorBlock: 100,
        });
        const owner = f.owner();
        const blocks = [block(101), block(102)];
        owner.commit(
            owner.applied({
                blocks,
                shared: true,
                collectionIds: [f.collectionId],
            }),
        );
        owner.commit(
            owner.historical({ blocks, collectionIds: [f.collectionId] }),
        );
        expect(f.storage.countBlocksInRange(1, 101, 102)).toBe(2);
        expect(
            f.storage.countCollectionSyncedBlocksInRange(
                1,
                f.collectionId,
                101,
                102,
            ),
        ).toBe(2);
        expect(
            f.storage.countCollectionSyncedBlocksInRange(
                1,
                untouched,
                101,
                102,
            ),
        ).toBe(0);
        commitRollbackFixture({
            storage: f.storage,
            chainId: 1,
            fromBlock: 102,
            owners: [],
        });
        expect(
            f.storage.countCollectionSyncedBlocksInRange(
                1,
                f.collectionId,
                101,
                102,
            ),
        ).toBe(1);
    });

    it("keeps bootstrap ownership unchanged for historical pre-anchor facts", () => {
        const f = transferFixture();
        const seller = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const prior = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        const bootstrap = new SqliteBootstrapStorage();
        bootstrap.insertSnapshotRows([
            {
                runId: 2,
                chainId: 1,
                collectionId: f.collectionId,
                contract: f.contract,
                tokenId: "1",
                owner: seller,
                anchorBlock: 100,
            },
        ]);
        finalizeBootstrapSnapshotFixture(bootstrap, {
            runId: 2,
            chainId: 1,
            collectionId: f.collectionId,
            contract: f.contract,
            anchorBlock: 100,
            anchorHash: block(100).hash,
            anchorTimestamp: 100,
        });
        const owner = f.owner();
        const data = emptyOnChainData();
        data.collectionScoped.nftTransferEvents = [
            f.transfer(99, 1, prior, seller),
        ];
        owner.commit(
            owner.historical({
                blocks: [block(99)],
                data,
                collectionIds: [f.collectionId],
            }),
        );
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: seller, amount: "1" },
        ]);
        expect(selectTransferCount(1, f.collectionId, "1")).toBe(1);
    });

    it("rejects an applied range crossing the base and accepts explicit history followed by post-base application", () => {
        const f = transferFixture();
        const owner = f.owner();
        const seller = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const buyer = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        const data = emptyOnChainData();
        data.collectionScoped.nftTransferEvents = [
            f.transfer(99, 1, buyer, seller),
            f.transfer(101, 1, seller, buyer),
        ];
        expect(() =>
            owner.commit(
                owner.applied({
                    blocks: [block(99), block(101)],
                    data,
                    shared: true,
                    collectionIds: [f.collectionId],
                }),
            ),
        ).toThrow();
        expect(selectTransferCount(1, f.collectionId, "1")).toBe(0);
        f.persist([data.collectionScoped.nftTransferEvents[0]!]);
        f.persist([data.collectionScoped.nftTransferEvents[1]!]);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: buyer, amount: "1" },
        ]);
        expect(selectTransferCount(1, f.collectionId, "1")).toBe(2);
    });
});
