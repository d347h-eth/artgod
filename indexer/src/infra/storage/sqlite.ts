import { db } from "@artgod/shared/database";
import { isDeepStrictEqual } from "node:util";
import {
    fillExecutionIdentity,
    fillAttributionItem,
} from "@artgod/shared/market-data/fills";
import {
    FILL_EXECUTION_CONFLICT,
    persistFillExecution,
    type FillExecutionWrite,
} from "./sqlite-fill-executions.js";
import { zeroHash } from "viem";
import { normalizeErc721Owner } from "@artgod/shared/evm/erc721-ownership";
import {
    COLLECTION_STANDARD,
    CollectionRecord,
} from "../../domain/collections.js";
import type { OnChainData, TransactionRecord } from "../../domain/onchain.js";
import type { StoragePort } from "../../ports/storage.js";
import type { ReorgForkStore } from "../../application/reorg-fork.js";
import type { ReorgHistorySnapshot } from "../../domain/reorg-fork.js";
import { ORDER_SOURCE_STATUS, ORDER_STATUS } from "../../domain/orders.js";
import { ORDER_RETIREMENT_REASON } from "../../domain/order-retention.js";
import {
    ChainSyncConflict,
    type ChainSyncCheckpoint,
    type SyncBlockHeader,
} from "../../domain/chain-sync.js";
import { assertSyncResultMatchesBlocks } from "../../domain/sync-result.js";
import {
    assertSameErc721Tokens,
    resolveErc721Ownership,
    type BalanceContext,
    type Erc721TokenReference,
} from "../../domain/ownership.js";
import type {
    Erc721RollbackSnapshot,
    ReorgRollbackPlan,
    ReorgRollbackStore,
} from "../../application/reorg-rollback.js";

type BalanceRow = { amount: string };
type BlockHashRow = { block_hash: string };
type BlockCountRow = { count: number };
type TransferRow = {
    collection_id: number;
    contract: string;
    from_address: string;
    to_address: string;
    token_id: string;
    amount: string;
    block_number: number;
    block_hash: string;
    block_timestamp: number;
    tx_hash: string;
    log_index: number;
    kind: "erc721" | "erc1155";
};

type BlockMeta = {
    timestamp: number;
};

type OwnershipCheckpointRow = {
    owner: string | null;
    block_number: number;
    block_hash: string;
    block_timestamp: number;
};

type Erc721OwnershipReplacement = {
    chainId: number;
    collectionId: number;
    contract: string;
    tokenId: string;
    // A null owner explicitly removes ownership, e.g. a burn or a rolled-back mint.
    owner: string | null;
    context: BalanceContext;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ROLLBACK_TRANSFER_PAGE_SIZE = 256;
export const FILL_ATTRIBUTION_CONFLICT =
    "Conflicting immutable fill attribution";

export class SqliteStorage
    implements StoragePort, ReorgRollbackStore, ReorgForkStore
{
    private selectReorgHeaders = db.prepare<[number, number, number]>(
        "SELECT block_number AS number, block_hash AS hash, parent_hash AS parentHash, timestamp FROM blocks WHERE chain_id = ? AND block_number BETWEEN ? AND ? ORDER BY block_number",
    );
    private selectSyncRevision = db.prepare<[number]>(
        "SELECT revision FROM chain_sync_revisions WHERE chain_id = ?",
    );
    private advanceSyncRevision = db.prepare<[number]>(
        "INSERT INTO chain_sync_revisions (chain_id, revision) VALUES (?, 1) " +
            "ON CONFLICT(chain_id) DO UPDATE SET revision = revision + 1",
    );
    private selectOwnershipCheckpoint = db.prepare<[number, number, string]>(
        "SELECT p.owner, p.block_number, p.block_hash, p.block_timestamp " +
            "FROM erc721_ownership_checkpoints p JOIN collections c ON c.collection_id = p.collection_id " +
            "WHERE p.chain_id = ? AND p.collection_id = ? AND p.token_id = ? " +
            "AND p.bootstrap_anchor_block IS c.bootstrap_anchor_block",
    );
    private upsertOwnershipCheckpoint = db.prepare<{
        chainId: number;
        collectionId: number;
        contract: string;
        tokenId: string;
        owner: string | null;
        blockNumber: number;
        blockHash: string;
        blockTimestamp: number;
    }>(
        "INSERT INTO erc721_ownership_checkpoints " +
            "(chain_id, collection_id, contract_address, token_id, owner, block_number, block_hash, block_timestamp, bootstrap_anchor_block) " +
            "SELECT @chainId, @collectionId, @contract, @tokenId, @owner, @blockNumber, @blockHash, @blockTimestamp, bootstrap_anchor_block " +
            "FROM collections WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "ON CONFLICT(chain_id, collection_id, token_id) DO UPDATE SET " +
            "contract_address = excluded.contract_address, owner = excluded.owner, block_number = excluded.block_number, " +
            "block_hash = excluded.block_hash, block_timestamp = excluded.block_timestamp, bootstrap_anchor_block = excluded.bootstrap_anchor_block",
    );
    private selectRollbackTokens = db.prepare<{
        chainId: number;
        fromBlock: number;
        standard: string;
    }>(
        "SELECT c.collection_id AS collectionId, c.address AS contract, t.token_id AS tokenId FROM (" +
            "SELECT collection_id, token_id FROM nft_transfer_events WHERE chain_id = @chainId AND block_number >= @fromBlock AND kind = @standard " +
            "UNION SELECT collection_id, token_id FROM nft_balances WHERE chain_id = @chainId AND last_block_number >= @fromBlock " +
            "UNION SELECT collection_id, token_id FROM erc721_ownership_checkpoints WHERE chain_id = @chainId AND block_number >= @fromBlock" +
            ") t JOIN collections c ON c.collection_id = t.collection_id " +
            "WHERE c.chain_id = @chainId AND c.standard = @standard AND c.bootstrap_anchor_block IS NOT NULL " +
            "ORDER BY c.collection_id, t.token_id",
    );
    private insertBlock = db.prepare<[number, number, string, string, number]>(
        "INSERT INTO blocks (chain_id, block_number, block_hash, parent_hash, timestamp) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(chain_id, block_number) DO UPDATE SET " +
            "block_hash = excluded.block_hash, parent_hash = excluded.parent_hash, timestamp = excluded.timestamp",
    );
    private upsertCollectionSyncBlock = db.prepare<{
        chainId: number;
        collectionId: number;
        blockNumber: number;
    }>(
        "INSERT INTO collection_sync_blocks (chain_id, collection_id, block_number) " +
            "VALUES (@chainId, @collectionId, @blockNumber) " +
            "ON CONFLICT(chain_id, collection_id, block_number) DO UPDATE SET " +
            "last_synced_at = CURRENT_TIMESTAMP",
    );
    private insertTransaction = db.prepare<
        [number, string, string, string | null, string, number, string, number]
    >(
        "INSERT OR IGNORE INTO transactions " +
            "(chain_id, tx_hash, from_address, to_address, input, block_number, block_hash, block_timestamp) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    private insertTransfer = db.prepare<
        [
            number,
            number,
            string,
            string,
            string,
            string,
            string,
            number,
            string,
            number,
            string,
            number,
            string,
        ]
    >(
        "INSERT OR IGNORE INTO nft_transfer_events " +
            "(chain_id, collection_id, contract_address, from_address, to_address, token_id, amount, block_number, block_hash, block_timestamp, tx_hash, log_index, kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    private insertFill = db.prepare(
        "INSERT INTO fills " +
            "(chain_id, collection_id, execution_id, item_index, kind, order_id, order_side, maker, taker, contract_address, token_id, amount, block_number, block_hash, block_timestamp, tx_hash, log_index) " +
            "VALUES (@chainId, @collectionId, @executionId, @itemIndex, @kind, @orderId, @orderSide, @maker, @taker, @contract, @tokenId, @amount, @blockNumber, @blockHash, @blockTimestamp, @txHash, @logIndex) ON CONFLICT(collection_id, execution_id, item_index) DO NOTHING",
    );
    private selectFillAttribution = db.prepare<{
        collectionId: number;
        executionId: string;
        itemIndex: number;
    }>(
        `SELECT chain_id AS chainId, collection_id AS collectionId,
            execution_id AS executionId, item_index AS itemIndex, kind,
            order_id AS orderId, order_side AS orderSide, maker, taker,
            contract_address AS contract, token_id AS tokenId, amount,
            block_number AS blockNumber, block_hash AS blockHash,
            block_timestamp AS blockTimestamp, tx_hash AS txHash, log_index AS logIndex
         FROM fills WHERE collection_id=@collectionId AND execution_id=@executionId AND item_index=@itemIndex`,
    );
    private insertCollectionExtensionEvent = db.prepare<{
        chainId: number;
        collectionId: number;
        extensionKey: string;
        eventKey: string;
        contractAddress: string;
        tokenId: string;
        maker: string | null;
        contentHash: string | null;
        blockNumber: number;
        blockHash: string;
        blockTimestamp: number;
        txHash: string;
        logIndex: number;
        payloadJson: string | null;
    }>(
        "INSERT OR IGNORE INTO collection_extension_events " +
            "(chain_id, collection_id, extension_key, event_key, contract_address, token_id, maker, content_hash, block_number, block_hash, block_timestamp, tx_hash, log_index, payload_json) " +
            "VALUES (@chainId, @collectionId, @extensionKey, @eventKey, @contractAddress, @tokenId, @maker, @contentHash, @blockNumber, @blockHash, @blockTimestamp, @txHash, @logIndex, @payloadJson)",
    );
    private upsertCollectionExtensionEventMedia = db.prepare<{
        chainId: number;
        collectionId: number;
        extensionKey: string;
        eventKey: string;
        contractAddress: string;
        tokenId: string;
        mediaRef: string;
        blockNumber: number;
        blockHash: string;
        blockTimestamp: number;
        txHash: string;
        logIndex: number;
        image: string | null;
        animationUrl: string | null;
        htmlContent: string | null;
        renderModesJson: string | null;
    }>(
        "INSERT INTO collection_extension_event_media " +
            "(chain_id, collection_id, extension_key, event_key, contract_address, token_id, media_ref, block_number, block_hash, block_timestamp, tx_hash, log_index, image, animation_url, html_content, render_modes_json) " +
            "VALUES (@chainId, @collectionId, @extensionKey, @eventKey, @contractAddress, @tokenId, @mediaRef, @blockNumber, @blockHash, @blockTimestamp, @txHash, @logIndex, @image, @animationUrl, @htmlContent, @renderModesJson) " +
            "ON CONFLICT(chain_id, collection_id, extension_key, event_key, tx_hash, log_index, token_id, media_ref) DO UPDATE SET " +
            "contract_address = excluded.contract_address, block_number = excluded.block_number, block_hash = excluded.block_hash, " +
            "block_timestamp = excluded.block_timestamp, image = excluded.image, animation_url = excluded.animation_url, " +
            "html_content = excluded.html_content, render_modes_json = excluded.render_modes_json, updated_at = CURRENT_TIMESTAMP",
    );
    private selectBalance = db.prepare<[number, number, string, string]>(
        "SELECT amount FROM nft_balances WHERE chain_id = ? AND collection_id = ? AND token_id = ? AND owner = ?",
    );
    private selectLatestTransfer = db.prepare<[number, number, string]>(
        "SELECT collection_id, contract_address AS contract, from_address, to_address, token_id, amount, block_number, block_hash, block_timestamp, tx_hash, log_index, kind " +
            "FROM nft_transfer_events WHERE chain_id = ? AND collection_id = ? AND token_id = ? " +
            "ORDER BY block_number DESC, log_index DESC LIMIT 1",
    );
    private deleteTokenBalances = db.prepare<[number, number, string]>(
        "DELETE FROM nft_balances WHERE chain_id = ? AND collection_id = ? AND token_id = ?",
    );
    private selectBlockHash = db.prepare<[number, number]>(
        "SELECT block_hash FROM blocks WHERE chain_id = ? AND block_number = ?",
    );
    private countBlocksInRangeStmt = db.prepare<[number, number, number]>(
        "SELECT COUNT(1) as count FROM blocks WHERE chain_id = ? AND block_number BETWEEN ? AND ?",
    );
    private countCollectionSyncedBlocksInRangeStmt = db.prepare<
        [number, number, number, number]
    >(
        "SELECT COUNT(1) as count FROM collection_sync_blocks " +
            "WHERE chain_id = ? AND collection_id = ? AND block_number BETWEEN ? AND ?",
    );
    private selectTransfersFromBlock = db.prepare<{
        chainId: number;
        fromBlock: number;
        afterBlock: number | null;
        afterLog: number;
        afterCollection: number;
        afterToken: string;
        afterTx: string;
        limit: number;
    }>(
        "SELECT collection_id, contract_address AS contract, from_address, to_address, token_id, amount, block_number, block_hash, block_timestamp, tx_hash, log_index, kind " +
            "FROM nft_transfer_events WHERE chain_id = @chainId AND block_number >= @fromBlock " +
            "AND (@afterBlock IS NULL OR block_number < @afterBlock " +
            "OR (block_number = @afterBlock AND log_index < @afterLog) " +
            "OR (block_number = @afterBlock AND log_index = @afterLog AND (collection_id, token_id, tx_hash) > (@afterCollection, @afterToken, @afterTx))) " +
            "ORDER BY block_number DESC, log_index DESC, collection_id ASC, token_id ASC, tx_hash ASC LIMIT @limit",
    );
    private upsertBalance = db.prepare<
        [
            number,
            number,
            string,
            string,
            string,
            string,
            number,
            string,
            number,
            string,
            number,
        ]
    >(
        "INSERT INTO nft_balances " +
            "(chain_id, collection_id, contract_address, token_id, owner, amount, last_block_number, last_block_hash, last_block_timestamp, last_tx_hash, last_log_index) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(chain_id, collection_id, token_id, owner) DO UPDATE SET " +
            "amount = excluded.amount, last_block_number = excluded.last_block_number, last_block_hash = excluded.last_block_hash, " +
            "last_block_timestamp = excluded.last_block_timestamp, last_tx_hash = excluded.last_tx_hash, last_log_index = excluded.last_log_index, " +
            "updated_at = CURRENT_TIMESTAMP",
    );
    private deleteBalance = db.prepare<[number, number, string, string]>(
        "DELETE FROM nft_balances WHERE chain_id = ? AND collection_id = ? AND token_id = ? AND owner = ?",
    );
    private deleteTransactionsFromBlock = db.prepare<[number, number]>(
        "DELETE FROM transactions WHERE chain_id = ? AND block_number >= ?",
    );
    private deleteTransfersFromBlock = db.prepare<[number, number]>(
        "DELETE FROM nft_transfer_events WHERE chain_id = ? AND block_number >= ?",
    );
    private deleteFillsFromBlock = db.prepare<[number, number]>(
        // Cascades through item facts and collection attributions, in the same rollback.
        "DELETE FROM fill_executions WHERE chain_id = ? AND block_number >= ?",
    );
    private deleteCollectionExtensionEventsFromBlock = db.prepare<{
        chainId: number;
        fromBlock: number;
    }>(
        "DELETE FROM collection_extension_events WHERE chain_id = @chainId AND block_number >= @fromBlock",
    );
    private deleteCollectionExtensionEventMediaFromBlock = db.prepare<{
        chainId: number;
        fromBlock: number;
    }>(
        "DELETE FROM collection_extension_event_media WHERE chain_id = @chainId AND block_number >= @fromBlock",
    );
    private deleteActivitiesFromBlock = db.prepare<[number, number]>(
        "DELETE FROM activities WHERE chain_id = ? AND block_number >= ?",
    );
    private deleteMetadataFromBlock = db.prepare<[number, number]>(
        "DELETE FROM token_metadata WHERE chain_id = ? AND block_number IS NOT NULL AND block_number >= ?",
    );
    private deleteOrdersFromBlock = db.prepare<[number, number]>(
        // Source cancellation remains definitive even when this row also has a
        // rolled-back chain outcome. Normal cleanup retires its payload later.
        "DELETE FROM orders WHERE chain_id = ? AND block_number IS NOT NULL AND block_number >= ? " +
            `AND source_status<>'${ORDER_SOURCE_STATUS.Cancelled}'`,
    );
    private resetOrderFillability = db.prepare<
        [string, number, number, string, string, string, string]
    >(
        "UPDATE orders SET fillability_status = ?, state_revision=state_revision+1, updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = ? AND collection_id = ? AND maker = ? AND contract_address = ? AND token_id = ? " +
            "AND fillability_status = ?",
    );
    private deleteBlocksFromBlock = db.prepare<[number, number]>(
        "DELETE FROM blocks WHERE chain_id = ? AND block_number >= ?",
    );
    private deleteCollectionSyncBlocksFromBlock = db.prepare<[number, number]>(
        "DELETE FROM collection_sync_blocks WHERE chain_id = ? AND block_number >= ?",
    );

    captureSyncCheckpoint(chainId: number): ChainSyncCheckpoint {
        const row = this.selectSyncRevision.get(chainId) as
            | { revision: number }
            | undefined;
        return { chainId, revision: row?.revision ?? 0 };
    }

    private assertSyncCheckpoint(checkpoint: ChainSyncCheckpoint): void {
        if (
            this.captureSyncCheckpoint(checkpoint.chainId).revision !==
            checkpoint.revision
        )
            throw new ChainSyncConflict(
                "Sync work predates a committed chain rollback",
            );
    }

    persistSyncResult({
        checkpoint,
        blocks,
        data,
        collections,
    }: {
        checkpoint: ChainSyncCheckpoint;
        blocks: readonly SyncBlockHeader[];
        data: OnChainData;
        collections: CollectionRecord[];
    }): void {
        const chainId = checkpoint.chainId;
        const run = db.writeTransaction(() => {
            this.assertSyncCheckpoint(checkpoint);
            assertSyncResultMatchesBlocks({ blocks, data });
            for (const block of blocks) {
                const storedHash = this.getBlockHash(chainId, block.number);
                if (storedHash && storedHash !== block.hash) {
                    throw new ChainSyncConflict(
                        `Sync conflicts with stored block ${block.number}; rollback is required`,
                    );
                }
            }
            const blockMeta = buildBlockMeta(blocks);
            const currentStateCollections = new Map(
                collections.map((collection) => [collection.id, collection]),
            );
            this.persistBlocks(chainId, blocks);
            this.persistCollectionSyncBlocks(chainId, blocks, collections);
            this.persistTransactions(chainId, data.transactions, blockMeta);
            const inserted = this.persistTransfers(chainId, data, blockMeta);
            this.persistFills(chainId, data, blockMeta);
            this.persistCollectionExtensionEvents(chainId, data, blockMeta);
            this.persistCollectionExtensionEventMedia(chainId, data, blockMeta);
            const currentStateTransfers = inserted.filter((event) => {
                const collection = currentStateCollections.get(
                    event.collectionId,
                );
                return Boolean(
                    collection?.canProjectCurrentStateAt(event.blockNumber),
                );
            });
            this.applyBalanceUpdatesFromEvents(
                chainId,
                currentStateTransfers,
                blockMeta,
            );
        });
        run();
    }

    getBlockHash(chainId: number, blockNumber: number): string | null {
        const row = this.selectBlockHash.get(chainId, blockNumber) as
            | BlockHashRow
            | undefined;
        return row?.block_hash ?? null;
    }

    captureReorgHistory(input: {
        chainId: number;
        fromBlock: number;
        toBlock: number;
    }): ReorgHistorySnapshot {
        // A deferred read transaction gives the revision and sparse headers one
        // snapshot, without acquiring the writer or keeping it open across RPC.
        return db.raw.transaction(() => ({
            checkpoint: this.captureSyncCheckpoint(input.chainId),
            fromBlock: input.fromBlock,
            toBlock: input.toBlock,
            headers: this.selectReorgHeaders.all(
                input.chainId,
                input.fromBlock,
                input.toBlock,
            ) as SyncBlockHeader[],
        }))();
    }

    // The recovery adapter holds its rollback writer through this validation and
    // the commit; a revision alone cannot fence intervening sparse header inserts.
    assertReorgHistoryUnchanged(expected: ReorgHistorySnapshot): void {
        this.assertSyncCheckpoint(expected.checkpoint);
        const current = this.captureReorgHistory({
            chainId: expected.checkpoint.chainId,
            fromBlock: expected.fromBlock,
            toBlock: expected.toBlock,
        });
        if (
            current.headers.length !== expected.headers.length ||
            current.headers.some((header, index) => {
                const previous = expected.headers[index];
                return (
                    header.number !== previous.number ||
                    header.hash !== previous.hash ||
                    header.parentHash !== previous.parentHash ||
                    header.timestamp !== previous.timestamp
                );
            })
        )
            throw new ChainSyncConflict(
                "Reorg ancestor history changed during preparation",
            );
    }

    countBlocksInRange(
        chainId: number,
        fromBlock: number,
        toBlock: number,
    ): number {
        if (fromBlock > toBlock) return 0;
        const row = this.countBlocksInRangeStmt.get(
            chainId,
            fromBlock,
            toBlock,
        ) as BlockCountRow | undefined;
        return row?.count ?? 0;
    }

    countCollectionSyncedBlocksInRange(
        chainId: number,
        collectionId: number,
        fromBlock: number,
        toBlock: number,
    ): number {
        if (fromBlock > toBlock) return 0;
        const row = this.countCollectionSyncedBlocksInRangeStmt.get(
            chainId,
            collectionId,
            fromBlock,
            toBlock,
        ) as BlockCountRow | undefined;
        return row?.count ?? 0;
    }

    prepareRollback(input: {
        chainId: number;
        fromBlock: number;
    }): ReorgRollbackPlan {
        if (!Number.isSafeInteger(input.fromBlock) || input.fromBlock < 1)
            throw new RangeError(
                "Rollback block must be a positive safe integer",
            );
        return {
            checkpoint: this.captureSyncCheckpoint(input.chainId),
            fromBlock: input.fromBlock,
            tokens: this.selectRollbackTokens.all({
                ...input,
                standard: COLLECTION_STANDARD.Erc721,
            }) as Erc721TokenReference[],
        };
    }

    rollbackFromBlock({
        plan,
        snapshot,
    }: {
        plan: ReorgRollbackPlan;
        snapshot: Erc721RollbackSnapshot;
    }): void {
        const { chainId } = plan.checkpoint;
        const fromBlock = plan.fromBlock;
        const run = db.writeTransaction(() => {
            this.assertSyncCheckpoint(plan.checkpoint);
            if (snapshot.block.blockNumber !== fromBlock - 1)
                throw new ChainSyncConflict(
                    "Rollback ownership snapshot has the wrong block",
                );
            const storedForkHash = this.getBlockHash(chainId, fromBlock - 1);
            if (storedForkHash && storedForkHash !== snapshot.block.blockHash)
                throw new ChainSyncConflict(
                    "Rollback fork no longer matches persisted history",
                );
            const currentTokens = this.selectRollbackTokens.all({
                chainId,
                fromBlock,
                standard: COLLECTION_STANDARD.Erc721,
            }) as Erc721TokenReference[];
            assertSameErc721Tokens({
                expected: plan.tokens,
                actual: currentTokens,
            });
            assertSameErc721Tokens({
                expected: plan.tokens,
                actual: snapshot.owners,
            });
            // Invalidate uncertain chain-derived terminal state. An OpenSea
            // cancellation is independent of this chain rollback and must stay.
            db.prepare(
                "DELETE FROM orders WHERE chain_id=? AND source_status<>? AND (source_status=? OR fillability_status IN (?,?))",
            ).run(
                chainId,
                ORDER_SOURCE_STATUS.Cancelled,
                ORDER_SOURCE_STATUS.Filled,
                ORDER_STATUS.Filled,
                ORDER_STATUS.Cancelled,
            );
            db.prepare<[number, string]>(
                "DELETE FROM market_order_retirements WHERE chain_id=? AND reason=?",
            ).run(chainId, ORDER_RETIREMENT_REASON.Terminal);
            // The driver disallows writes while a read cursor is open. Close
            // each bounded page before applying deltas, in this same transaction.
            let after: TransferRow | undefined;
            while (true) {
                const events = this.selectTransfersFromBlock.all({
                    chainId,
                    fromBlock,
                    limit: ROLLBACK_TRANSFER_PAGE_SIZE,
                    afterBlock: after?.block_number ?? null,
                    afterLog: after?.log_index ?? 0,
                    afterCollection: after?.collection_id ?? 0,
                    afterToken: after?.token_id ?? "",
                    afterTx: after?.tx_hash ?? "",
                }) as TransferRow[];
                for (const event of events) {
                    if (event.kind === COLLECTION_STANDARD.Erc1155)
                        this.rollbackErc1155Transfer(chainId, event);
                    this.resetOrderFromTransfer(chainId, event);
                }
                if (events.length < ROLLBACK_TRANSFER_PAGE_SIZE) break;
                after = events[events.length - 1];
            }
            for (const token of snapshot.owners) {
                const owner =
                    token.owner === null
                        ? null
                        : normalizeErc721Owner(token.owner);
                this.upsertOwnershipCheckpoint.run({
                    chainId,
                    ...token,
                    owner,
                    ...snapshot.block,
                });
                this.replaceErc721Ownership({
                    chainId,
                    ...token,
                    owner,
                    context: {
                        ...snapshot.block,
                        txHash: zeroHash,
                        logIndex: 0,
                    },
                });
            }
            this.deleteTransfersFromBlock.run(chainId, fromBlock);
            this.deleteFillsFromBlock.run(chainId, fromBlock);
            this.deleteCollectionExtensionEventsFromBlock.run({
                chainId,
                fromBlock,
            });
            this.deleteCollectionExtensionEventMediaFromBlock.run({
                chainId,
                fromBlock,
            });
            this.deleteActivitiesFromBlock.run(chainId, fromBlock);
            this.deleteMetadataFromBlock.run(chainId, fromBlock);
            this.deleteOrdersFromBlock.run(chainId, fromBlock);
            this.deleteTransactionsFromBlock.run(chainId, fromBlock);
            this.deleteCollectionSyncBlocksFromBlock.run(chainId, fromBlock);
            this.deleteBlocksFromBlock.run(chainId, fromBlock);
            // Retain the verified fork header even when its transfer facts were
            // missing, so later reorg checks can invalidate this checkpoint.
            this.persistBlocks(chainId, [
                {
                    number: snapshot.block.blockNumber,
                    hash: snapshot.block.blockHash,
                    parentHash: snapshot.block.parentHash,
                    timestamp: snapshot.block.blockTimestamp,
                },
            ]);
            this.advanceSyncRevision.run(chainId);
        });
        run();
    }

    private persistBlocks(
        chainId: number,
        blocks: readonly SyncBlockHeader[],
    ): void {
        // Store block metadata for reorg checks and future gap detection.
        for (const block of blocks) {
            this.insertBlock.run(
                chainId,
                block.number,
                block.hash,
                block.parentHash,
                block.timestamp,
            );
        }
    }

    private persistCollectionSyncBlocks(
        chainId: number,
        blocks: readonly SyncBlockHeader[],
        collections: CollectionRecord[],
    ): void {
        // Mark coverage for each collection this sync job actually targeted.
        for (const collection of collections) {
            for (const block of blocks) {
                this.upsertCollectionSyncBlock.run({
                    chainId,
                    collectionId: collection.id,
                    blockNumber: block.number,
                });
            }
        }
    }

    private persistTransfers(
        chainId: number,
        data: OnChainData,
        blockMeta: Map<number, BlockMeta>,
    ): OnChainData["collectionScoped"]["nftTransferEvents"] {
        // Transfers are immutable; insert once (ignore duplicates).
        const inserted: OnChainData["collectionScoped"]["nftTransferEvents"] =
            [];
        for (const event of data.collectionScoped.nftTransferEvents) {
            const contract = event.contract.toLowerCase();
            const blockTimestamp = resolveBlockTimestamp(
                blockMeta,
                event.blockNumber,
            );
            const result = this.insertTransfer.run(
                chainId,
                event.collectionId,
                contract,
                event.from.toLowerCase(),
                event.to.toLowerCase(),
                event.tokenId,
                event.amount,
                event.blockNumber,
                event.blockHash,
                blockTimestamp,
                event.txHash,
                event.logIndex,
                event.kind,
            );
            if (result.changes > 0) {
                inserted.push(event);
            }
        }
        return inserted;
    }

    private persistFills(
        chainId: number,
        data: OnChainData,
        blockMeta: Map<number, BlockMeta>,
    ): void {
        const executions = new Map<string, FillExecutionWrite>();
        for (const fill of data.collectionScoped.fillEvents) {
            const contract = fill.contract.toLowerCase();
            const blockTimestamp = resolveBlockTimestamp(
                blockMeta,
                fill.blockNumber,
            );
            const executionId = fillExecutionIdentity(
                chainId,
                fill.kind ?? "unknown",
                fill.txHash,
                fill.logIndex,
            );
            const execution: FillExecutionWrite = {
                executionId,
                chainId,
                kind: fill.kind ?? "unknown",
                blockNumber: fill.blockNumber,
                blockHash: fill.blockHash,
                blockTimestamp,
                txHash: fill.txHash.toLowerCase(),
                logIndex: fill.logIndex,
                execution: fill.execution,
            };
            const previous = executions.get(executionId);
            // Sharing an item context does not establish identical block provenance.
            if (previous && !isDeepStrictEqual(previous, execution))
                throw new Error(FILL_EXECUTION_CONFLICT);
            if (!previous) {
                persistFillExecution(execution);
                executions.set(executionId, execution);
            }
            const item = fillAttributionItem(
                fill.execution,
                fill.executionItemIndex,
                { contract, tokenId: fill.tokenId, amount: fill.amount },
            );
            const attribution = {
                chainId,
                collectionId: fill.collectionId,
                executionId,
                itemIndex: fill.executionItemIndex,
                kind: fill.kind ?? "unknown",
                orderId: fill.orderId ?? null,
                orderSide: fill.orderSide ?? null,
                maker: fill.maker?.toLowerCase() ?? null,
                taker: fill.taker?.toLowerCase() ?? null,
                contract,
                tokenId: fill.tokenId,
                amount: item.amount,
                blockNumber: fill.blockNumber,
                blockHash: fill.blockHash,
                blockTimestamp,
                txHash: fill.txHash.toLowerCase(),
                logIndex: fill.logIndex,
            };
            if (this.insertFill.run(attribution).changes === 0) {
                // An idempotent replay must agree with every stored attribution fact.
                const existing = this.selectFillAttribution.get({
                    collectionId: attribution.collectionId,
                    executionId,
                    itemIndex: attribution.itemIndex,
                }) as typeof attribution | undefined;
                if (!isDeepStrictEqual(existing, attribution))
                    throw new Error(FILL_ATTRIBUTION_CONFLICT);
            }
        }
    }

    private persistCollectionExtensionEvents(
        chainId: number,
        data: OnChainData,
        blockMeta: Map<number, BlockMeta>,
    ): void {
        // Extension facts are immutable and remain available to facts-only feeds.
        for (const event of data.collectionScoped.collectionExtensionEvents) {
            const blockTimestamp = resolveBlockTimestamp(
                blockMeta,
                event.blockNumber,
            );
            this.insertCollectionExtensionEvent.run({
                chainId,
                collectionId: event.collectionId,
                extensionKey: event.extensionKey,
                eventKey: event.eventKey,
                contractAddress: event.contract.toLowerCase(),
                tokenId: event.tokenId ?? "",
                maker: event.maker?.toLowerCase() ?? null,
                contentHash: event.contentHash?.toLowerCase() ?? null,
                blockNumber: event.blockNumber,
                blockHash: event.blockHash,
                blockTimestamp,
                txHash: event.txHash,
                logIndex: event.logIndex,
                payloadJson: event.payload
                    ? JSON.stringify(event.payload)
                    : null,
            });
        }
    }

    private persistCollectionExtensionEventMedia(
        chainId: number,
        data: OnChainData,
        blockMeta: Map<number, BlockMeta>,
    ): void {
        // Event media is extension-owned and keyed to immutable event identity.
        for (const media of data.collectionScoped
            .collectionExtensionEventMedia) {
            const blockTimestamp = resolveBlockTimestamp(
                blockMeta,
                media.blockNumber,
            );
            this.upsertCollectionExtensionEventMedia.run({
                chainId,
                collectionId: media.collectionId,
                extensionKey: media.extensionKey,
                eventKey: media.eventKey,
                contractAddress: media.contract.toLowerCase(),
                tokenId: media.tokenId,
                mediaRef: media.mediaRef,
                blockNumber: media.blockNumber,
                blockHash: media.blockHash,
                blockTimestamp,
                txHash: media.txHash,
                logIndex: media.logIndex,
                image: media.image ?? null,
                animationUrl: media.animationUrl ?? null,
                htmlContent: media.htmlContent ?? null,
                renderModesJson: media.renderModes
                    ? JSON.stringify(media.renderModes)
                    : null,
            });
        }
    }

    // Projects newly inserted post-anchor transfers into current balances.
    // ERC721 uses the latest transfer or verified fork ownership checkpoint;
    // ERC1155 applies each transfer's balance deltas once.
    private applyBalanceUpdatesFromEvents(
        chainId: number,
        events: OnChainData["collectionScoped"]["nftTransferEvents"],
        blockMeta: Map<number, BlockMeta>,
    ): void {
        for (const event of events) {
            if (event.kind === COLLECTION_STANDARD.Erc721) {
                // Gap repairs can arrive behind realtime or newer backfills.
                // Project the latest persisted transfer, including burns, rather
                // than letting delivery order determine the token's owner.
                const latest = this.selectLatestTransfer.get(
                    chainId,
                    event.collectionId,
                    event.tokenId,
                ) as TransferRow | undefined;
                const checkpoint = this.selectOwnershipCheckpoint.get(
                    chainId,
                    event.collectionId,
                    event.tokenId,
                ) as OwnershipCheckpointRow | undefined;
                const state = resolveErc721Ownership({
                    latestTransfer: latest
                        ? {
                              owner:
                                  latest.to_address === ZERO_ADDRESS
                                      ? null
                                      : latest.to_address,
                              context: {
                                  blockNumber: latest.block_number,
                                  blockHash: latest.block_hash,
                                  blockTimestamp: latest.block_timestamp,
                                  txHash: latest.tx_hash,
                                  logIndex: latest.log_index,
                              },
                          }
                        : null,
                    checkpoint: checkpoint
                        ? {
                              owner: checkpoint.owner,
                              context: {
                                  blockNumber: checkpoint.block_number,
                                  blockHash: checkpoint.block_hash,
                                  blockTimestamp: checkpoint.block_timestamp,
                                  txHash: zeroHash,
                                  logIndex: 0,
                              },
                          }
                        : null,
                });
                this.replaceErc721Ownership({
                    chainId,
                    collectionId: event.collectionId,
                    contract: event.contract.toLowerCase(),
                    tokenId: event.tokenId,
                    ...state,
                });
                continue;
            }

            const context: BalanceContext = {
                blockNumber: event.blockNumber,
                blockHash: event.blockHash,
                blockTimestamp: resolveBlockTimestamp(
                    blockMeta,
                    event.blockNumber,
                ),
                txHash: event.txHash,
                logIndex: event.logIndex,
            };
            const contract = event.contract.toLowerCase();
            const from = event.from.toLowerCase();
            const to = event.to.toLowerCase();
            const amount = BigInt(event.amount);
            this.applyErc1155Transfer(
                chainId,
                event.collectionId,
                contract,
                event.tokenId,
                from,
                to,
                amount,
                context,
            );
        }
    }

    private rollbackErc1155Transfer(chainId: number, event: TransferRow): void {
        const contract = event.contract.toLowerCase();
        const from = event.from_address.toLowerCase();
        const to = event.to_address.toLowerCase();
        const context: BalanceContext = {
            blockNumber: event.block_number,
            blockHash: event.block_hash,
            blockTimestamp: event.block_timestamp,
            txHash: event.tx_hash,
            logIndex: event.log_index,
        };

        const amount = BigInt(event.amount);
        this.applyErc1155Transfer(
            chainId,
            event.collection_id,
            contract,
            event.token_id,
            to,
            from,
            amount,
            context,
        );
    }

    private resetOrderFromTransfer(chainId: number, event: TransferRow): void {
        const maker = event.from_address.toLowerCase();
        const contract = event.contract.toLowerCase();
        const tokenId = event.token_id;
        if (maker === ZERO_ADDRESS) return;
        this.resetOrderFillability.run(
            ORDER_STATUS.Fillable,
            chainId,
            event.collection_id,
            maker,
            contract,
            tokenId,
            ORDER_STATUS.NoBalance,
        );
    }

    // Replace every balance row for this token with the specified owner (or none).
    // Ingestion and rollback call this within their encompassing write transaction.
    private replaceErc721Ownership({
        chainId,
        collectionId,
        contract,
        tokenId,
        owner,
        context,
    }: Erc721OwnershipReplacement): void {
        this.deleteTokenBalances.run(chainId, collectionId, tokenId);
        if (owner !== null) {
            this.upsertBalance.run(
                chainId,
                collectionId,
                contract,
                tokenId,
                owner,
                "1",
                context.blockNumber,
                context.blockHash,
                context.blockTimestamp,
                context.txHash,
                context.logIndex,
            );
        }
    }

    private applyErc1155Transfer(
        chainId: number,
        collectionId: number,
        contract: string,
        tokenId: string,
        from: string,
        to: string,
        amount: bigint,
        context: BalanceContext,
    ): void {
        if (from !== ZERO_ADDRESS) {
            this.applyBalanceDelta(
                chainId,
                collectionId,
                contract,
                tokenId,
                from,
                -amount,
                context,
            );
        }
        if (to !== ZERO_ADDRESS) {
            this.applyBalanceDelta(
                chainId,
                collectionId,
                contract,
                tokenId,
                to,
                amount,
                context,
            );
        }
    }

    private applyBalanceDelta(
        chainId: number,
        collectionId: number,
        contract: string,
        tokenId: string,
        owner: string,
        delta: bigint,
        context: BalanceContext,
    ): void {
        const current = this.selectBalance.get(
            chainId,
            collectionId,
            tokenId,
            owner,
        ) as BalanceRow | undefined;
        const currentAmount = current ? BigInt(current.amount) : 0n;
        const nextAmount = currentAmount + delta;

        if (nextAmount === 0n) {
            this.deleteBalance.run(chainId, collectionId, tokenId, owner);
            return;
        }

        this.upsertBalance.run(
            chainId,
            collectionId,
            contract,
            tokenId,
            owner,
            nextAmount.toString(),
            context.blockNumber,
            context.blockHash,
            context.blockTimestamp,
            context.txHash,
            context.logIndex,
        );
    }

    private persistTransactions(
        chainId: number,
        transactions: TransactionRecord[],
        blockMeta: Map<number, BlockMeta>,
    ): void {
        for (const tx of transactions) {
            const blockTimestamp = resolveBlockTimestamp(
                blockMeta,
                tx.blockNumber,
            );
            this.insertTransaction.run(
                chainId,
                tx.hash,
                tx.from.toLowerCase(),
                tx.to?.toLowerCase() ?? null,
                tx.input,
                tx.blockNumber,
                tx.blockHash,
                blockTimestamp,
            );
        }
    }
}

function buildBlockMeta(
    blocks: readonly SyncBlockHeader[],
): Map<number, BlockMeta> {
    const map = new Map<number, BlockMeta>();
    for (const block of blocks) {
        map.set(block.number, { timestamp: block.timestamp });
    }
    return map;
}

function resolveBlockTimestamp(
    blockMeta: Map<number, BlockMeta>,
    blockNumber: number,
): number {
    const meta = blockMeta.get(blockNumber);
    if (!meta) {
        throw new Error(`Missing block timestamp for block ${blockNumber}`);
    }
    return meta.timestamp;
}
