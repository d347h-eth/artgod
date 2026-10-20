import { createAppliedSyncFixture } from "./applied-sync-fixture.js";
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
    let applied: ReturnType<typeof createAppliedSyncFixture> | undefined;
    const owner = () =>
        (applied ??= createAppliedSyncFixture({
            chainId: 1,
            anchor: syncBlockFixture(100),
            collections: [loadCollection(1, collectionId)],
        }));
    const persist = (events: NftTransferEvent[]) => {
        if (!events.length) return;
        const coordinator = owner();
        const data = emptyOnChainData();
        data.collectionScoped.nftTransferEvents = events;
        const from = Math.min(...events.map((event) => event.blockNumber));
        const to = Math.max(...events.map((event) => event.blockNumber));
        const tip = coordinator.progress.chainProgress(1)!.applied.number;
        if (to <= tip) {
            // Replayed/older facts enrich history without reapplying ownership.
            const numbers = [
                ...new Set(events.map((event) => event.blockNumber)),
            ].sort((a, b) => a - b);
            coordinator.commit(
                coordinator.historical({
                    blocks: numbers.map(syncBlockFixture),
                    data,
                    collectionIds: [collectionId],
                }),
            );
            return;
        }
        if (from <= tip)
            throw new Error(
                "Split historical and applied fixture acquisitions explicitly",
            );
        const blocks = Array.from({ length: to - tip }, (_, i) =>
            syncBlockFixture(tip + i + 1),
        );
        coordinator.commit(
            coordinator.applied({
                blocks,
                data,
                shared: true,
                collectionIds: [collectionId],
            }),
        );
    };
    return { collectionId, storage, contract, transfer, persist, owner };
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
