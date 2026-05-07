import { db } from "@artgod/shared/database";
import { CollectionRecord } from "../../domain/collections.js";
import type { OnChainData, TransactionRecord } from "../../domain/onchain.js";
import type { StoragePort } from "../../ports/storage.js";
import type { RpcBlock } from "../../ports/rpc.js";
import { ORDER_STATUS } from "../../domain/orders.js";

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

type BalanceContext = {
    blockNumber: number;
    blockHash: string;
    blockTimestamp: number;
    txHash: string;
    logIndex: number;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class SqliteStorage implements StoragePort {
    private insertBlock = db.prepare<[number, number, string, string, number]>(
        "INSERT INTO blocks (chain_id, block_number, block_hash, parent_hash, timestamp) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(chain_id, block_number) DO UPDATE SET " +
            "block_hash = excluded.block_hash, parent_hash = excluded.parent_hash, timestamp = excluded.timestamp",
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
    private insertFill = db.prepare<
        [
            number,
            number,
            string,
            string | null,
            string | null,
            string | null,
            string | null,
            string,
            string,
            string | null,
            string | null,
            string | null,
            number,
            string,
            number,
            string,
            number,
        ]
    >(
        "INSERT OR IGNORE INTO fills " +
            "(chain_id, collection_id, kind, order_id, order_side, maker, taker, contract_address, token_id, amount, price, currency, block_number, block_hash, block_timestamp, tx_hash, log_index) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    private selectBalance = db.prepare<[number, number, string, string]>(
        "SELECT amount FROM nft_balances WHERE chain_id = ? AND collection_id = ? AND token_id = ? AND owner = ?",
    );
    private selectBlockHash = db.prepare<[number, number]>(
        "SELECT block_hash FROM blocks WHERE chain_id = ? AND block_number = ?",
    );
    private countBlocksInRangeStmt = db.prepare<[number, number, number]>(
        "SELECT COUNT(1) as count FROM blocks WHERE chain_id = ? AND block_number BETWEEN ? AND ?",
    );
    private selectTransfersFromBlock = db.prepare<[number, number]>(
        "SELECT collection_id, contract_address AS contract, from_address, to_address, token_id, amount, block_number, block_hash, block_timestamp, tx_hash, log_index, kind " +
            "FROM nft_transfer_events WHERE chain_id = ? AND block_number >= ? " +
            "ORDER BY block_number DESC, log_index DESC",
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
        "DELETE FROM fills WHERE chain_id = ? AND block_number >= ?",
    );
    private deleteCollectionExtensionEventsFromBlock = db.prepare<{
        chainId: number;
        fromBlock: number;
    }>(
        "DELETE FROM collection_extension_events WHERE chain_id = @chainId AND block_number >= @fromBlock",
    );
    private deleteActivitiesFromBlock = db.prepare<[number, number]>(
        "DELETE FROM activities WHERE chain_id = ? AND block_number >= ?",
    );
    private deleteMetadataFromBlock = db.prepare<[number, number]>(
        "DELETE FROM token_metadata WHERE chain_id = ? AND block_number IS NOT NULL AND block_number >= ?",
    );
    private deleteOrdersFromBlock = db.prepare<[number, number]>(
        "DELETE FROM orders WHERE chain_id = ? AND block_number IS NOT NULL AND block_number >= ?",
    );
    private resetOrderFillability = db.prepare<
        [string, number, number, string, string, string, string]
    >(
        "UPDATE orders SET fillability_status = ?, updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = ? AND collection_id = ? AND maker = ? AND contract_address = ? AND token_id = ? " +
            "AND fillability_status = ?",
    );
    private deleteBlocksFromBlock = db.prepare<[number, number]>(
        "DELETE FROM blocks WHERE chain_id = ? AND block_number >= ?",
    );

    persistSyncResult(
        chainId: number,
        blocks: RpcBlock[],
        data: OnChainData,
        collections: CollectionRecord[],
    ): void {
        const run = db.raw.transaction(() => {
            const blockMeta = buildBlockMeta(blocks);
            const currentStateCollections = new Map(
                collections.map((collection) => [collection.id, collection]),
            );
            this.persistBlocks(chainId, blocks);
            this.persistTransactions(chainId, data.transactions, blockMeta);
            const inserted = this.persistTransfers(chainId, data, blockMeta);
            this.persistFills(chainId, data, blockMeta);
            this.persistCollectionExtensionEvents(chainId, data, blockMeta);
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

    rollbackFromBlock(chainId: number, fromBlock: number): void {
        const run = db.raw.transaction(() => {
            const events = this.selectTransfersFromBlock.all(
                chainId,
                fromBlock,
            ) as TransferRow[];
            for (const event of events) {
                this.applyTransferRollback(chainId, event);
                this.resetOrderFromTransfer(chainId, event);
            }
            this.deleteTransfersFromBlock.run(chainId, fromBlock);
            this.deleteFillsFromBlock.run(chainId, fromBlock);
            this.deleteCollectionExtensionEventsFromBlock.run({
                chainId,
                fromBlock,
            });
            this.deleteActivitiesFromBlock.run(chainId, fromBlock);
            this.deleteMetadataFromBlock.run(chainId, fromBlock);
            this.deleteOrdersFromBlock.run(chainId, fromBlock);
            this.deleteTransactionsFromBlock.run(chainId, fromBlock);
            this.deleteBlocksFromBlock.run(chainId, fromBlock);
        });
        run();
    }

    private persistBlocks(chainId: number, blocks: RpcBlock[]): void {
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
        for (const fill of data.collectionScoped.fillEvents) {
            const contract = fill.contract.toLowerCase();
            const blockTimestamp = resolveBlockTimestamp(
                blockMeta,
                fill.blockNumber,
            );
            this.insertFill.run(
                chainId,
                fill.collectionId,
                fill.kind ?? "unknown",
                fill.orderId ?? null,
                fill.orderSide ?? null,
                fill.maker?.toLowerCase() ?? null,
                fill.taker?.toLowerCase() ?? null,
                contract,
                fill.tokenId,
                fill.amount ?? null,
                fill.price ?? null,
                fill.currency?.toLowerCase() ?? null,
                fill.blockNumber,
                fill.blockHash,
                blockTimestamp,
                fill.txHash,
                fill.logIndex,
            );
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
                tokenId: event.tokenId,
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

    private applyBalanceUpdatesFromEvents(
        chainId: number,
        events: OnChainData["collectionScoped"]["nftTransferEvents"],
        blockMeta: Map<number, BlockMeta>,
    ): void {
        // Only apply balance deltas for newly inserted transfers (idempotent).
        for (const event of events) {
            const context = buildBalanceContext(
                event.blockNumber,
                event.blockHash,
                resolveBlockTimestamp(blockMeta, event.blockNumber),
                event.txHash,
                event.logIndex,
            );
            const contract = event.contract.toLowerCase();
            const from = event.from.toLowerCase();
            const to = event.to.toLowerCase();

            if (event.kind === "erc721") {
                this.applyErc721Transfer(
                    chainId,
                    event.collectionId,
                    contract,
                    event.tokenId,
                    from,
                    to,
                    context,
                );
                continue;
            }

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

    private applyTransferRollback(chainId: number, event: TransferRow): void {
        const contract = event.contract.toLowerCase();
        const from = event.from_address.toLowerCase();
        const to = event.to_address.toLowerCase();
        const context = buildBalanceContext(
            event.block_number,
            event.block_hash,
            event.block_timestamp,
            event.tx_hash,
            event.log_index,
        );

        if (event.kind === "erc721") {
            this.applyErc721Transfer(
                chainId,
                event.collection_id,
                contract,
                event.token_id,
                to,
                from,
                context,
            );
            return;
        }

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

    private applyErc721Transfer(
        chainId: number,
        collectionId: number,
        contract: string,
        tokenId: string,
        from: string,
        to: string,
        context: BalanceContext,
    ): void {
        if (from !== ZERO_ADDRESS) {
            this.deleteBalance.run(chainId, collectionId, tokenId, from);
        }
        if (to !== ZERO_ADDRESS) {
            this.upsertBalance.run(
                chainId,
                collectionId,
                contract,
                tokenId,
                to,
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

function buildBlockMeta(blocks: RpcBlock[]): Map<number, BlockMeta> {
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

function buildBalanceContext(
    blockNumber: number,
    blockHash: string,
    blockTimestamp: number,
    txHash: string,
    logIndex: number,
): BalanceContext {
    return {
        blockNumber,
        blockHash,
        blockTimestamp,
        txHash,
        logIndex,
    };
}
