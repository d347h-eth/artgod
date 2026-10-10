import { FINALIZED_SYNC_CHECK_POLICY } from "./chain-fixture.js";
import { db } from "@artgod/shared/database";
import { SqliteCollectionRegistry } from "../../src/infra/collections/sqlite.js";
import { SqliteStorage } from "../../src/infra/storage/sqlite.js";
import type {
    NftTransferEvent,
    OnChainData,
} from "../../src/domain/onchain.js";
import { COLLECTION_STANDARD } from "../../src/domain/collections.js";
import { syncBlockFixture } from "./chain-fixture.js";

export function insertCollection(input: {
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

export function loadCollection(chainId: number, collectionId: number) {
    const registry = new SqliteCollectionRegistry();
    const collection = registry.getCollection(chainId, collectionId);
    if (!collection) {
        throw new Error(`Missing collection ${collectionId}`);
    }
    return collection;
}

export function selectBalanceOwners(
    chainId: number,
    collectionId: number,
    tokenId: string,
): Array<{ owner: string; amount: string }> {
    return db
        .prepare<
            [number, number, string]
        >("SELECT owner, amount FROM nft_balances " + "WHERE chain_id = ? AND collection_id = ? AND token_id = ? " + "ORDER BY owner ASC")
        .all(chainId, collectionId, tokenId) as Array<{
        owner: string;
        amount: string;
    }>;
}

export function selectTransferCount(
    chainId: number,
    collectionId: number,
    tokenId: string,
): number {
    const row = db
        .prepare<
            [number, number, string]
        >("SELECT COUNT(*) AS count FROM nft_transfer_events " + "WHERE chain_id = ? AND collection_id = ? AND token_id = ?")
        .get(chainId, collectionId, tokenId) as { count: number } | undefined;
    return row?.count ?? 0;
}

export function transferFixture() {
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
        blockHash: syncBlockFixture(blockNumber).hash,
        txHash: `0x${String(blockNumber * 100 + logIndex).padStart(64, "0")}`,
        kind: COLLECTION_STANDARD.Erc721,
    });
    const persist = (events: NftTransferEvent[]) => {
        const data = emptyOnChainData();
        data.collectionScoped.nftTransferEvents = events;
        storage.persistSyncResult({
            canonicalCheck: FINALIZED_SYNC_CHECK_POLICY,
            checkpoint: storage.captureSyncCheckpoint(1),
            blocks: events.map((event) => ({
                ...syncBlockFixture(event.blockNumber),
                hash: event.blockHash,
            })),
            data: data,
            collections: [loadCollection(1, collectionId)],
        });
    };
    return { collectionId, storage, transfer, persist };
}

export function emptyOnChainData(): OnChainData {
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
