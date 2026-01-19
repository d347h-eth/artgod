import { db } from "@artgod/shared/database";
import type { OnChainData, TransactionRecord } from "../../domain/onchain.js";
import type { StoragePort } from "../../ports/storage.js";
import type { RpcBlock } from "../../ports/rpc.js";

type BalanceRow = { amount: string };
type BlockHashRow = { block_hash: string };
type TransferRow = {
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
            "(chain_id, contract, from_address, to_address, token_id, amount, block_number, block_hash, block_timestamp, tx_hash, log_index, kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    private selectBalance = db.prepare<[number, string, string, string]>(
        "SELECT amount FROM nft_balances WHERE chain_id = ? AND contract = ? AND token_id = ? AND owner = ?",
    );
    private selectBlockHash = db.prepare<[number, number]>(
        "SELECT block_hash FROM blocks WHERE chain_id = ? AND block_number = ?",
    );
    private selectTransfersFromBlock = db.prepare<[number, number]>(
        "SELECT contract, from_address, to_address, token_id, amount, block_number, block_hash, block_timestamp, tx_hash, log_index, kind " +
            "FROM nft_transfer_events WHERE chain_id = ? AND block_number >= ? " +
            "ORDER BY block_number DESC, log_index DESC",
    );
    private upsertBalance = db.prepare<
        [
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
            "(chain_id, contract, token_id, owner, amount, last_block_number, last_block_hash, last_block_timestamp, last_tx_hash, last_log_index) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(chain_id, contract, token_id, owner) DO UPDATE SET " +
            "amount = excluded.amount, last_block_number = excluded.last_block_number, last_block_hash = excluded.last_block_hash, " +
            "last_block_timestamp = excluded.last_block_timestamp, last_tx_hash = excluded.last_tx_hash, last_log_index = excluded.last_log_index, " +
            "updated_at = CURRENT_TIMESTAMP",
    );
    private deleteBalance = db.prepare<[number, string, string, string]>(
        "DELETE FROM nft_balances WHERE chain_id = ? AND contract = ? AND token_id = ? AND owner = ?",
    );
    private deleteTransactionsFromBlock = db.prepare<[number, number]>(
        "DELETE FROM transactions WHERE chain_id = ? AND block_number >= ?",
    );
    private deleteTransfersFromBlock = db.prepare<[number, number]>(
        "DELETE FROM nft_transfer_events WHERE chain_id = ? AND block_number >= ?",
    );
    private deleteActivitiesFromBlock = db.prepare<[number, number]>(
        "DELETE FROM activities WHERE chain_id = ? AND block_number >= ?",
    );
    private deleteBlocksFromBlock = db.prepare<[number, number]>(
        "DELETE FROM blocks WHERE chain_id = ? AND block_number >= ?",
    );

    persistSyncResult(
        chainId: number,
        blocks: RpcBlock[],
        data: OnChainData,
    ): void {
        const run = db.raw.transaction(() => {
            const blockMeta = buildBlockMeta(blocks);
            this.persistBlocks(chainId, blocks);
            this.persistTransactions(chainId, data.transactions, blockMeta);
            const inserted = this.persistTransfers(chainId, data, blockMeta);
            this.applyBalanceUpdatesFromEvents(chainId, inserted, blockMeta);
        });
        run();
    }

    getBlockHash(chainId: number, blockNumber: number): string | null {
        const row = this.selectBlockHash.get(chainId, blockNumber) as
            | BlockHashRow
            | undefined;
        return row?.block_hash ?? null;
    }

    rollbackFromBlock(chainId: number, fromBlock: number): void {
        const run = db.raw.transaction(() => {
            const events = this.selectTransfersFromBlock.all(
                chainId,
                fromBlock,
            ) as TransferRow[];
            for (const event of events) {
                this.applyTransferRollback(chainId, event);
            }
            this.deleteTransfersFromBlock.run(chainId, fromBlock);
            this.deleteActivitiesFromBlock.run(chainId, fromBlock);
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
    ): OnChainData["nftTransferEvents"] {
        // Transfers are immutable; insert once (ignore duplicates).
        const inserted: OnChainData["nftTransferEvents"] = [];
        for (const event of data.nftTransferEvents) {
            const blockTimestamp = resolveBlockTimestamp(
                blockMeta,
                event.blockNumber,
            );
            const result = this.insertTransfer.run(
                chainId,
                event.contract.toLowerCase(),
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

    private applyBalanceUpdatesFromEvents(
        chainId: number,
        events: OnChainData["nftTransferEvents"],
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
            contract,
            event.token_id,
            to,
            from,
            amount,
            context,
        );
    }

    private applyErc721Transfer(
        chainId: number,
        contract: string,
        tokenId: string,
        from: string,
        to: string,
        context: BalanceContext,
    ): void {
        if (from !== ZERO_ADDRESS) {
            this.deleteBalance.run(chainId, contract, tokenId, from);
        }
        if (to !== ZERO_ADDRESS) {
            this.upsertBalance.run(
                chainId,
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
        contract: string,
        tokenId: string,
        owner: string,
        delta: bigint,
        context: BalanceContext,
    ): void {
        const current = this.selectBalance.get(
            chainId,
            contract,
            tokenId,
            owner,
        ) as BalanceRow | undefined;
        const currentAmount = current ? BigInt(current.amount) : 0n;
        const nextAmount = currentAmount + delta;

        if (nextAmount === 0n) {
            this.deleteBalance.run(chainId, contract, tokenId, owner);
            return;
        }

        this.upsertBalance.run(
            chainId,
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
