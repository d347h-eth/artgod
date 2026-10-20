import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { zeroAddress } from "viem";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import {
    COLLECTION_STANDARD,
    type CollectionStandard,
} from "../src/domain/collections.js";
import type { NftTransferEvent } from "../src/domain/onchain.js";
import { createAppliedSyncFixture } from "./helpers/applied-sync-fixture.js";
import {
    emptyOnChainData,
    insertCollection,
    loadCollection,
    selectBalanceOwners,
    selectTransferCount,
} from "./helpers/ownership-fixture.js";
import { commitRollbackFixture } from "./helpers/rollback-fixture.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const CHAIN = 1;
const CONTRACT = "0x0000000000000000000000000000000000000007";
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";

describe("ownership follows accepted collection application", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    function fixture(standard: CollectionStandard) {
        const collectionId = insertCollection({
            chainId: CHAIN,
            slug: "coordinated-ownership",
            address: CONTRACT,
            anchorBlock: 900,
        });
        db.prepare(
            "UPDATE collections SET standard=? WHERE collection_id=?",
        ).run(standard, collectionId);
        const work = createAppliedSyncFixture({
            chainId: CHAIN,
            anchor: block(900),
            collections: [loadCollection(CHAIN, collectionId)],
        });
        function transfer(
            number: number,
            from: string,
            to: string,
            amount = "1",
        ): NftTransferEvent {
            return {
                collectionId,
                contract: CONTRACT,
                tokenId: "1",
                from,
                to,
                amount,
                kind: standard,
                blockNumber: number,
                blockHash: block(number).hash,
                txHash: `0x${String(number).padStart(64, "0")}`,
                logIndex: 1,
            };
        }
        function data(events: NftTransferEvent[]) {
            const result = emptyOnChainData();
            result.collectionScoped.nftTransferEvents = events;
            return result;
        }
        function sharedThrough(number: number) {
            const from = work.progress.chainProgress(CHAIN)!.applied.number + 1;
            work.commit(
                work.applied({
                    shared: true,
                    collectionIds: [],
                    blocks: Array.from(
                        { length: number - from + 1 },
                        (_, offset) => block(from + offset),
                    ),
                }),
            );
        }
        function history(events: NftTransferEvent[]) {
            work.commit(
                work.historical({
                    collectionIds: [collectionId],
                    blocks: events.map((event) => block(event.blockNumber)),
                    data: data(events),
                }),
            );
        }
        function apply(events: NftTransferEvent[]) {
            const acquired = work.applied({
                shared: false,
                collectionIds: [collectionId],
                blocks: events.map((event) => block(event.blockNumber)),
                data: data(events),
            });
            work.commit(acquired);
            return acquired;
        }
        return {
            ...work,
            collectionId,
            transfer,
            data,
            sharedThrough,
            history,
            apply,
        };
    }

    it("applies a previously stored ERC1155 transfer once when collection catch-up reaches it", () => {
        const f = fixture(COLLECTION_STANDARD.Erc1155);
        f.sharedThrough(902);
        const mint = f.transfer(901, zeroAddress, A, "5");
        const sale = f.transfer(902, A, B, "2");
        f.history([mint, sale]);
        expect(selectTransferCount(CHAIN, f.collectionId, "1")).toBe(2);
        expect(selectBalanceOwners(CHAIN, f.collectionId, "1")).toEqual([]);
        expect(
            f.progress.collectionProgress(CHAIN, f.collectionId)?.applied
                .number,
        ).toBe(900);
        const first = f.apply([mint]);
        expect(selectBalanceOwners(CHAIN, f.collectionId, "1")).toEqual([
            { owner: A, amount: "5" },
        ]);
        expect(() => f.commit(first)).toThrow(ChainSyncConflict);
        expect(selectBalanceOwners(CHAIN, f.collectionId, "1")).toEqual([
            { owner: A, amount: "5" },
        ]);
        f.apply([sale]);
        expect(selectBalanceOwners(CHAIN, f.collectionId, "1")).toEqual([
            { owner: A, amount: "3" },
            { owner: B, amount: "2" },
        ]);
        f.history([mint, sale]);
        expect(selectBalanceOwners(CHAIN, f.collectionId, "1")).toEqual([
            { owner: A, amount: "3" },
            { owner: B, amount: "2" },
        ]);
    });

    it("does not expose ERC721 ownership from historical facts beyond the applied collection prefix", () => {
        const f = fixture(COLLECTION_STANDARD.Erc721);
        f.sharedThrough(903);
        const events = [
            f.transfer(901, zeroAddress, A),
            f.transfer(902, A, B),
            f.transfer(903, B, C),
        ];
        f.history(events);
        f.apply([events[0]!]);
        expect(selectBalanceOwners(CHAIN, f.collectionId, "1")).toEqual([
            { owner: A, amount: "1" },
        ]);
        expect(
            f.progress.validationCheckpoint(CHAIN, f.collectionId)?.block
                .number,
        ).toBe(901);
        f.apply([events[1]!]);
        expect(selectBalanceOwners(CHAIN, f.collectionId, "1")).toEqual([
            { owner: B, amount: "1" },
        ]);
        f.apply([events[2]!]);
        expect(selectBalanceOwners(CHAIN, f.collectionId, "1")).toEqual([
            { owner: C, amount: "1" },
        ]);
    });

    it("reverses only applied ERC1155 deltas while deleting unapplied orphan history", () => {
        const f = fixture(COLLECTION_STANDARD.Erc1155);
        f.sharedThrough(903);
        const mint = f.transfer(901, zeroAddress, A, "5");
        const applied = f.transfer(902, A, B, "2");
        const historyOnly = f.transfer(903, B, C, "1");
        f.history([mint, applied, historyOnly]);
        f.apply([mint, applied]);
        commitRollbackFixture({
            storage: f.storage,
            chainId: CHAIN,
            fromBlock: 902,
            owners: [],
        });
        expect(selectBalanceOwners(CHAIN, f.collectionId, "1")).toEqual([
            { owner: A, amount: "5" },
        ]);
        expect(selectTransferCount(CHAIN, f.collectionId, "1")).toBe(1);
        expect(f.progress.chainProgress(CHAIN)).toMatchObject({
            checkpoint: { revision: 1 },
            applied: { number: 901 },
        });
        expect(
            f.progress.collectionProgress(CHAIN, f.collectionId),
        ).toMatchObject({
            checkpoint: { revision: 1 },
            applied: { number: 901 },
        });
    });

    it("does not request or overwrite ERC721 ownership for a history-only orphan above scope progress", () => {
        const f = fixture(COLLECTION_STANDARD.Erc721);
        f.sharedThrough(902);
        const mint = f.transfer(901, zeroAddress, A);
        const historyOnly = f.transfer(902, A, B);
        f.history([mint, historyOnly]);
        f.apply([mint]);
        expect(
            f.storage.prepareRollback({ chainId: CHAIN, fromBlock: 902 })
                .tokens,
        ).toEqual([]);
        commitRollbackFixture({
            storage: f.storage,
            chainId: CHAIN,
            fromBlock: 902,
            owners: [],
        });
        expect(selectBalanceOwners(CHAIN, f.collectionId, "1")).toEqual([
            { owner: A, amount: "1" },
        ]);
        expect(
            f.progress.validationCheckpoint(CHAIN, f.collectionId),
        ).toMatchObject({ revision: 1, block: { number: 901 } });
    });
});
