import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { encodeEventTopics, type Hex } from "viem";
import { ERC721_ABI } from "../src/abi/index.js";
import { syncRange } from "../src/application/sync.js";
import { ChainSyncConflict } from "../src/domain/chain-sync.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import {
    NFT_APPROVAL_SCOPE,
    type NftTransferEvent,
    type OnChainData,
} from "../src/domain/onchain.js";
import {
    GLOBAL_MAKER_TRIGGER_REASON,
    TOKEN_SCOPED_MAKER_TRIGGER_REASON,
} from "../src/domain/maker-triggers.js";
import { SqliteCollectionRegistry } from "../src/infra/collections/sqlite.js";
import type { RpcLog, RpcProviderPort } from "../src/ports/rpc.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    emptyOnChainData,
    loadCollection,
    selectBalanceOwners,
    transferFixture,
} from "./helpers/ownership-fixture.js";
import { commitRollbackFixture } from "./helpers/rollback-fixture.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";

const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C = "0xcccccccccccccccccccccccccccccccccccccccc";
const D = "0xdddddddddddddddddddddddddddddddddddddddd";
const ORPHAN_HASH = block(202).hash;
const TEST_EXTENSION_KEY = "test-extension";
const TEST_EXTENSION_EVENT = "test-event";

function snapshot() {
    return Object.fromEntries(
        [
            "blocks",
            "collection_sync_blocks",
            "transactions",
            "nft_transfer_events",
            "nft_balances",
            "fills",
            "collection_extension_events",
            "collection_extension_event_media",
            "chain_sync_revisions",
        ].map((table) => [
            table,
            db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ]),
    );
}

function factGroups(data: OnChainData) {
    return Object.fromEntries([
        ["transactions", data.transactions],
        ...Object.entries(data.collectionScoped),
        ...Object.entries(data.global).map(([key, values]) => [
            `global.${key}`,
            values,
        ]),
    ]) as Record<string, Array<{ blockNumber: number; blockHash: string }>>;
}

function dataWithAllFacts(event: NftTransferEvent): OnChainData {
    return {
        transactions: [
            {
                hash: event.txHash,
                from: A,
                to: B,
                input: "0x",
                blockNumber: event.blockNumber,
                blockHash: event.blockHash,
            },
        ],
        collectionScoped: {
            nftTransferEvents: [{ ...event }],
            nftApprovalEvents: [
                {
                    ...event,
                    kind: COLLECTION_STANDARD.Erc721,
                    scope: NFT_APPROVAL_SCOPE.Token,
                    owner: A,
                    operator: B,
                },
            ],
            nftBalanceDeltas: [{ ...event, owner: B, delta: "1" }],
            fillEvents: [
                {
                    ...event,
                    maker: A,
                    taker: B,
                    executionItemIndex: 0,
                    execution: {
                        protocolAddress: event.contract,
                        items: [
                            {
                                index: 0,
                                side: "offer",
                                itemType: 2,
                                contract: event.contract,
                                identifier: event.tokenId,
                                amount: event.amount,
                                recipient: B,
                            },
                        ],
                    },
                },
            ],
            orderInfos: [{ ...event, maker: A }],
            makerTriggers: [
                {
                    ...event,
                    maker: A,
                    reason: TOKEN_SCOPED_MAKER_TRIGGER_REASON.NftTransfer,
                },
            ],
            metadataRefreshEvents: [
                { ...event, reason: "test", trigger: "test" },
            ],
            metadataRefreshRangeEvents: [
                {
                    ...event,
                    fromTokenId: "1",
                    toTokenId: "2",
                    reason: "test",
                    trigger: "test",
                },
            ],
            collectionExtensionEvents: [
                {
                    ...event,
                    extensionKey: TEST_EXTENSION_KEY,
                    eventKey: TEST_EXTENSION_EVENT,
                },
            ],
            collectionExtensionEventMedia: [
                {
                    ...event,
                    extensionKey: TEST_EXTENSION_KEY,
                    eventKey: TEST_EXTENSION_EVENT,
                    mediaRef: "test-media",
                },
            ],
        },
        global: {
            cancelEvents: [{ ...event, maker: A }],
            makerTriggers: [
                {
                    ...event,
                    maker: A,
                    reason: GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
                },
            ],
        },
    };
}

describe("canonical sync persistence", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        db.exec(
            "DELETE FROM nft_balances; DELETE FROM nft_transfer_events; DELETE FROM collections; DELETE FROM transactions; DELETE FROM collection_sync_blocks; DELETE FROM blocks; DELETE FROM chain_sync_revisions;",
        );
    });

    function harness() {
        const f = transferFixture();
        f.persist([f.transfer(101, 1, A, B)]);
        return {
            ...f,
            checkpoint: f.storage.captureSyncCheckpoint(1),
            collections: [loadCollection(1, f.collectionId)],
        };
    }

    it("rejects the reproduced orphan transfer with canonical metadata without changing ownership or coverage", () => {
        const f = harness();
        const before = snapshot();
        const data = emptyOnChainData();
        data.collectionScoped.nftTransferEvents.push({
            ...f.transfer(102, 1, B, C),
            blockHash: ORPHAN_HASH,
        });
        expect(() =>
            f.storage.persistSyncResult({ ...f, blocks: [block(102)], data }),
        ).toThrow(ChainSyncConflict);
        expect(snapshot()).toEqual(before);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: B, amount: "1" },
        ]);
    });

    it.each(Object.keys(factGroups(emptyOnChainData())))(
        "rejects orphaned %s alongside otherwise valid facts",
        (name) => {
            const f = harness();
            const before = snapshot();
            const data = dataWithAllFacts(f.transfer(102, 1, B, C));
            factGroups(data)[name]![0]!.blockHash = ORPHAN_HASH;
            expect(() =>
                f.storage.persistSyncResult({
                    ...f,
                    blocks: [block(102)],
                    data,
                }),
            ).toThrow(ChainSyncConflict);
            expect(snapshot()).toEqual(before);
        },
    );

    it("requires a supplied header for every referenced block, even if stored previously", () => {
        const f = harness();
        const before = snapshot();
        const data = emptyOnChainData();
        data.collectionScoped.nftTransferEvents.push(f.transfer(101, 2, B, C));
        expect(() =>
            f.storage.persistSyncResult({ ...f, blocks: [block(102)], data }),
        ).toThrow(ChainSyncConflict);
        expect(snapshot()).toEqual(before);
    });

    it("does not overwrite an existing conflicting header or write earlier blocks in the batch", () => {
        const f = harness();
        const before = snapshot();
        expect(() =>
            f.storage.persistSyncResult({
                ...f,
                blocks: [block(102), { ...block(101), hash: ORPHAN_HASH }],
                data: emptyOnChainData(),
            }),
        ).toThrow(ChainSyncConflict);
        expect(snapshot()).toEqual(before);
    });

    it("rejects a mixed parent chain even when there are no events", () => {
        const f = harness();
        const before = snapshot();
        expect(() =>
            f.storage.persistSyncResult({
                ...f,
                blocks: [
                    block(102),
                    { ...block(103), parentHash: ORPHAN_HASH },
                ],
                data: emptyOnChainData(),
            }),
        ).toThrow(ChainSyncConflict);
        expect(snapshot()).toEqual(before);
    });

    it.each([
        { ...block(102), hash: ORPHAN_HASH },
        { ...block(102), timestamp: 999 },
        { ...block(102), parentHash: ORPHAN_HASH },
    ])("rejects conflicting duplicate block metadata: %j", (conflict) => {
        const f = harness();
        const before = snapshot();
        expect(() =>
            f.storage.persistSyncResult({
                ...f,
                blocks: [block(102), conflict],
                data: emptyOnChainData(),
            }),
        ).toThrow(ChainSyncConflict);
        expect(snapshot()).toEqual(before);
    });

    it("accepts sparse, out-of-order history and repeated identical headers idempotently", () => {
        const f = transferFixture();
        const events = [
            f.transfer(103, 1, B, C),
            f.transfer(101, 1, A, B),
            f.transfer(103, 2, C, C),
        ];
        f.persist(events);
        f.persist(events);
        expect(f.storage.countBlocksInRange(1, 101, 103)).toBe(2);
        expect(
            f.storage.countCollectionSyncedBlocksInRange(
                1,
                f.collectionId,
                101,
                103,
            ),
        ).toBe(2);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: C, amount: "1" },
        ]);
        expect(
            db
                .prepare("SELECT count(*) AS count FROM nft_transfer_events")
                .get(),
        ).toEqual({ count: 3 });
    });

    it("accepts replacement canonical facts after verified rollback removes the old branch", () => {
        const f = harness();
        f.persist([f.transfer(102, 1, B, C)]);
        commitRollbackFixture({
            storage: f.storage,
            chainId: 1,
            fromBlock: 102,
            owners: [{ collectionId: f.collectionId, tokenId: "1", owner: B }],
        });
        const data = emptyOnChainData();
        data.collectionScoped.nftTransferEvents.push({
            ...f.transfer(102, 1, B, D),
            blockHash: ORPHAN_HASH,
        });
        f.storage.persistSyncResult({
            ...f,
            checkpoint: f.storage.captureSyncCheckpoint(1),
            blocks: [{ ...block(102), hash: ORPHAN_HASH }],
            data,
        });
        expect(f.storage.getBlockHash(1, 102)).toBe(ORPHAN_HASH);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: D, amount: "1" },
        ]);
    });

    it("rejects receipt facts from a different branch before fill decoding attributes them", async () => {
        const f = harness();
        const event = f.transfer(102, 1, B, C);
        const log: RpcLog = {
            address: event.contract as Hex,
            data: "0x",
            topics: encodeEventTopics({
                abi: ERC721_ABI,
                eventName: "Transfer",
                args: { from: B, to: C, tokenId: 1n },
            }) as Hex[],
            blockNumber: event.blockNumber,
            blockHash: event.blockHash as Hex,
            transactionHash: event.txHash as Hex,
            logIndex: event.logIndex,
        };
        const rpc = {
            getLogs: vi.fn().mockResolvedValueOnce([log]).mockResolvedValue([]),
            getTransaction: vi.fn(async () => ({
                hash: event.txHash,
                from: B,
                to: C,
                input: "0x",
            })),
            getTransactionReceipt: vi.fn(async () => ({
                transactionHash: event.txHash,
                logs: [{ ...log, blockHash: ORPHAN_HASH }],
            })),
        } as unknown as RpcProviderPort;
        const before = snapshot();
        await expect(
            syncRange(rpc, 1, f.collections, new SqliteCollectionRegistry(), {
                fromBlock: 102,
                toBlock: 102,
            }),
        ).rejects.toBeInstanceOf(ChainSyncConflict);
        expect(rpc.getTransactionReceipt).toHaveBeenCalledWith(event.txHash, {
            fresh: true,
        });
        expect(snapshot()).toEqual(before);
    });
});
