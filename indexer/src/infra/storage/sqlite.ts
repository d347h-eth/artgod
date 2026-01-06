import { db } from "@artgod/shared/database";
import type { OnChainData } from "../../domain/onchain.js";
import type { StoragePort } from "../../ports/storage.js";
import type { RpcBlock } from "../../ports/rpc.js";

type BalanceRow = { amount: string };

export class SqliteStorage implements StoragePort {
    private insertBlock = db.prepare<
        [number, number, string, string, number]
    >(
        "INSERT INTO blocks (chain_id, block_number, block_hash, parent_hash, timestamp) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(chain_id, block_number) DO UPDATE SET " +
            "block_hash = excluded.block_hash, parent_hash = excluded.parent_hash, timestamp = excluded.timestamp",
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
            string,
            number,
            string,
        ]
    >(
        "INSERT OR IGNORE INTO nft_transfer_events " +
            "(chain_id, contract, from_address, to_address, token_id, amount, block_number, block_hash, tx_hash, log_index, kind) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    private selectBalance = db.prepare<
        [number, string, string, string]
    >(
        "SELECT amount FROM nft_balances WHERE chain_id = ? AND contract = ? AND token_id = ? AND owner = ?",
    );
    private upsertBalance = db.prepare<
        [number, string, string, string, string]
    >(
        "INSERT INTO nft_balances (chain_id, contract, token_id, owner, amount) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(chain_id, contract, token_id, owner) DO UPDATE SET amount = excluded.amount, updated_at = CURRENT_TIMESTAMP",
    );
    private deleteBalance = db.prepare<[number, string, string, string]>(
        "DELETE FROM nft_balances WHERE chain_id = ? AND contract = ? AND token_id = ? AND owner = ?",
    );

    persistSyncResult(
        chainId: number,
        blocks: RpcBlock[],
        data: OnChainData,
    ): void {
        const run = db.raw.transaction(() => {
            this.persistBlocks(chainId, blocks);
            const inserted = this.persistTransfers(chainId, data);
            this.applyBalanceUpdatesFromEvents(chainId, inserted);
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
    ): OnChainData["nftTransferEvents"] {
        // Transfers are immutable; insert once (ignore duplicates).
        const inserted: OnChainData["nftTransferEvents"] = [];
        for (const event of data.nftTransferEvents) {
            const result = this.insertTransfer.run(
                chainId,
                event.contract.toLowerCase(),
                event.from.toLowerCase(),
                event.to.toLowerCase(),
                event.tokenId,
                event.amount,
                event.blockNumber,
                event.blockHash,
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
    ): void {
        // Only apply balance deltas for newly inserted transfers (idempotent).
        const zero = "0x0000000000000000000000000000000000000000";
        for (const event of events) {
            const contract = event.contract.toLowerCase();
            const from = event.from.toLowerCase();
            const to = event.to.toLowerCase();

            if (event.kind === "erc721") {
                if (from !== zero) {
                    this.deleteBalance.run(
                        chainId,
                        contract,
                        event.tokenId,
                        from,
                    );
                }
                if (to !== zero) {
                    this.upsertBalance.run(
                        chainId,
                        contract,
                        event.tokenId,
                        to,
                        "1",
                    );
                }
                continue;
            }

            const amount = BigInt(event.amount);
            if (from !== zero) {
                this.applyBalanceDelta(
                    chainId,
                    contract,
                    event.tokenId,
                    from,
                    -amount,
                );
            }
            if (to !== zero) {
                this.applyBalanceDelta(
                    chainId,
                    contract,
                    event.tokenId,
                    to,
                    amount,
                );
            }
        }
    }

    private applyBalanceDelta(
        chainId: number,
        contract: string,
        tokenId: string,
        owner: string,
        delta: bigint,
    ): void {
        const current = this.selectBalance.get(
            chainId,
            contract,
            tokenId,
            owner,
        ) as BalanceRow | undefined;
        const currentAmount = current
            ? BigInt(current.amount)
            : 0n;
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
        );
    }
}
