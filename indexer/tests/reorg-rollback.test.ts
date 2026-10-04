import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { zeroAddress } from "viem";
import { RollbackChainRange } from "../src/application/reorg-rollback.js";
import { RpcRollbackOwnershipSnapshot } from "../src/infra/ownership/rpc-rollback-snapshot.js";
import { SqliteBootstrapStorage } from "../src/infra/bootstrap/sqlite.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    emptyOnChainData,
    loadCollection,
    selectBalanceOwners,
    selectTransferCount,
    transferFixture,
} from "./helpers/ownership-fixture.js";
import { commitRollbackFixture } from "./helpers/rollback-fixture.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
const D = "0xdddddddddddddddddddddddddddddddddddddddd";

describe("verified reorg ownership rollback", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        db.exec(
            "DELETE FROM nft_balances; DELETE FROM nft_transfer_events; DELETE FROM collections; DELETE FROM collection_sync_blocks; DELETE FROM blocks; DELETE FROM chain_sync_revisions;",
        );
    });

    function rollbackHarness(owner: string) {
        const f = transferFixture();
        const rpc = {
            getBlock: vi.fn(async (number) => block(number)),
            readContractAtBlock: vi.fn(async () => owner),
        };
        const rollback = new RollbackChainRange(
            f.storage,
            new RpcRollbackOwnershipSnapshot(rpc),
        );
        return { ...f, rpc, rollback };
    }

    it("restores the fork owner despite missing history and an empty canonical resync", async () => {
        const f = rollbackHarness(A);
        f.persist([f.transfer(103, 1, B, C)]); // A -> B at 102 is missing.
        await f.rollback.execute({ ...block(100), chainId: 1 });
        f.storage.persistSyncResult({
            checkpoint: f.storage.captureSyncCheckpoint(1),
            blocks: [101, 102, 103].map(block),
            data: emptyOnChainData(),
            collections: [loadCollection(1, f.collectionId)],
        });
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: A, amount: "1" },
        ]);
        expect(
            f.storage.countCollectionSyncedBlocksInRange(
                1,
                f.collectionId,
                101,
                103,
            ),
        ).toBe(3);
        expect(selectTransferCount(1, f.collectionId, "1")).toBe(0);
        expect(f.rpc.readContractAtBlock).toHaveBeenCalledWith(
            expect.objectContaining({
                args: [1n],
                block: {
                    chainId: 1,
                    blockNumber: 100,
                    blockHash: block(100).hash,
                },
            }),
        );
    });

    it("retains a fork checkpoint through old repairs and allows newer transfers", async () => {
        const f = rollbackHarness(C);
        f.persist([f.transfer(105, 1, C, D)]);
        await f.rollback.execute({ ...block(104), chainId: 1 });
        f.persist([f.transfer(102, 1, A, B)]);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: C, amount: "1" },
        ]);
        expect(
            db
                .prepare(
                    "SELECT last_block_number FROM nft_balances WHERE collection_id = ?",
                )
                .get(f.collectionId),
        ).toEqual({ last_block_number: 104 });
        f.persist([f.transfer(106, 1, C, D)]);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: D, amount: "1" },
        ]);
    });

    it("retains absent ownership and includes it in a later deeper rollback", () => {
        const f = transferFixture();
        f.persist([f.transfer(105, 1, A, B)]);
        commitRollbackFixture({
            storage: f.storage,
            chainId: 1,
            fromBlock: 105,
            owners: [
                { collectionId: f.collectionId, tokenId: "1", owner: null },
            ],
        });
        f.persist([f.transfer(102, 1, zeroAddress, A)]);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([]);
        const plan = f.storage.prepareRollback({ chainId: 1, fromBlock: 104 });
        expect(plan.tokens).toHaveLength(1); // No balance row or raw fact exists at/after 104.
        commitRollbackFixture({
            storage: f.storage,
            chainId: 1,
            fromBlock: 104,
            owners: [{ collectionId: f.collectionId, tokenId: "1", owner: A }],
        });
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: A, amount: "1" },
        ]);
    });

    it("rejects sync work captured before rollback without reintroducing coverage or facts", async () => {
        const f = rollbackHarness(A);
        const checkpoint = f.storage.captureSyncCheckpoint(1);
        const orphan = f.transfer(103, 1, B, C);
        f.persist([orphan]);
        await f.rollback.execute({ ...block(100), chainId: 1 });
        const data = emptyOnChainData();
        data.collectionScoped.nftTransferEvents = [orphan];
        expect(() =>
            f.storage.persistSyncResult({
                checkpoint,
                blocks: [block(103)],
                data,
                collections: [loadCollection(1, f.collectionId)],
            }),
        ).toThrow(ChainSyncConflict);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: A, amount: "1" },
        ]);
        expect(selectTransferCount(1, f.collectionId, "1")).toBe(0);
        expect(
            f.storage.countCollectionSyncedBlocksInRange(
                1,
                f.collectionId,
                103,
                103,
            ),
        ).toBe(0);
    });

    it("rejects a rollback plan when another affected token appears during RPC reads", async () => {
        const f = rollbackHarness(A);
        f.persist([f.transfer(103, 1, B, C)]);
        f.rpc.readContractAtBlock.mockImplementationOnce(async () => {
            f.persist([{ ...f.transfer(104, 1, A, D), tokenId: "2" }]);
            return A;
        });
        await expect(
            f.rollback.execute({ ...block(100), chainId: 1 }),
        ).rejects.toThrow(ChainSyncConflict);
        expect(selectTransferCount(1, f.collectionId, "1")).toBe(1);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: C, amount: "1" },
        ]);
        expect(f.storage.captureSyncCheckpoint(1).revision).toBe(0);
    });

    it.each(["RPC failure", "block changed"])(
        "does not mutate local state after %s",
        async (failure) => {
            const f = rollbackHarness(A);
            f.persist([f.transfer(103, 1, B, C)]);
            if (failure === "RPC failure")
                f.rpc.readContractAtBlock.mockRejectedValueOnce(
                    new Error(failure),
                );
            else
                f.rpc.getBlock
                    .mockResolvedValueOnce(block(100))
                    .mockResolvedValueOnce({
                        ...block(100),
                        hash: block(101).hash,
                    });
            await expect(
                f.rollback.execute({ ...block(100), chainId: 1 }),
            ).rejects.toThrow();
            expect(selectTransferCount(1, f.collectionId, "1")).toBe(1);
            expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
                { owner: C, amount: "1" },
            ]);
            expect(f.storage.captureSyncCheckpoint(1).revision).toBe(0);
        },
    );

    it("rolls the whole write back when a later ownership checkpoint fails", async () => {
        const f = rollbackHarness(A);
        f.persist([
            f.transfer(103, 1, B, C),
            { ...f.transfer(103, 2, A, D), tokenId: "2" },
        ]);
        db.exec(
            "CREATE TEMP TRIGGER reject_ownership_checkpoint BEFORE INSERT ON erc721_ownership_checkpoints WHEN NEW.token_id = '2' BEGIN SELECT RAISE(ABORT, 'fixture checkpoint failure'); END;",
        );
        try {
            await expect(
                f.rollback.execute({ ...block(100), chainId: 1 }),
            ).rejects.toThrow("fixture checkpoint failure");
            expect(selectTransferCount(1, f.collectionId, "1")).toBe(1);
            expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
                { owner: C, amount: "1" },
            ]);
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM erc721_ownership_checkpoints",
                    )
                    .get(),
            ).toEqual({ count: 0 });
            expect(f.storage.captureSyncCheckpoint(1).revision).toBe(0);
        } finally {
            db.exec("DROP TRIGGER reject_ownership_checkpoint");
        }
    });

    it("reverses ERC1155 deltas across multiple pages with the same block/log index", () => {
        const f = transferFixture();
        db.prepare(
            "UPDATE collections SET standard = ? WHERE collection_id = ?",
        ).run(COLLECTION_STANDARD.Erc1155, f.collectionId);
        f.persist(
            Array.from({ length: 1000 }, (_, index) => ({
                ...f.transfer(103, 1, zeroAddress, A),
                kind: COLLECTION_STANDARD.Erc1155,
                tokenId: String(index),
            })),
        );
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM nft_balances").get(),
        ).toEqual({ count: 1000 });
        commitRollbackFixture({
            storage: f.storage,
            chainId: 1,
            fromBlock: 103,
            owners: [],
        });
        expect(
            db.prepare("SELECT COUNT(*) AS count FROM nft_balances").get(),
        ).toEqual({ count: 0 });
        expect(
            db
                .prepare("SELECT COUNT(*) AS count FROM nft_transfer_events")
                .get(),
        ).toEqual({ count: 0 });
    });

    it("clears fork checkpoints when a new bootstrap snapshot replaces ownership", async () => {
        const f = rollbackHarness(A);
        f.persist([f.transfer(103, 1, B, C)]);
        await f.rollback.execute({ ...block(100), chainId: 1 });
        const bootstrap = new SqliteBootstrapStorage();
        const contract = f.storage.prepareRollback({
            chainId: 1,
            fromBlock: 100,
        }).tokens[0].contract;
        bootstrap.insertSnapshotRows([
            {
                runId: 1,
                chainId: 1,
                collectionId: f.collectionId,
                contract,
                tokenId: "1",
                owner: D,
                anchorBlock: 100,
            },
        ]);
        bootstrap.finalizeSnapshot({
            runId: 1,
            chainId: 1,
            collectionId: f.collectionId,
            contract,
            anchorBlock: 100,
            anchorHash: block(100).hash,
            anchorTimestamp: 100,
        });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM erc721_ownership_checkpoints",
                )
                .get(),
        ).toEqual({ count: 0 });
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: D, amount: "1" },
        ]);
    });
});
