import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { ACTIVITY_KIND } from "../../domain/activities.js";
import type {
    ActivityDomainPort,
    DomainSyncContext,
} from "../../ports/domain-handlers.js";

type TransferRow = {
    collection_id: number;
    contract: string;
    token_id: string;
    from_address: string;
    to_address: string;
    amount: string;
    block_number: number;
    tx_hash: string;
    log_index: number;
};

type FillRow = {
    collection_id: number;
    contract: string;
    token_id: string;
    order_side: string | null;
    maker: string | null;
    taker: string | null;
    amount: string | null;
    block_number: number;
    tx_hash: string;
    log_index: number;
};

export class SqliteActivityDomain implements ActivityDomainPort {
    private selectTransfers = db.prepare<[number, number, number]>(
        "SELECT collection_id, contract_address AS contract, token_id, from_address, to_address, amount, block_number, tx_hash, log_index " +
            "FROM nft_transfer_events WHERE chain_id = ? AND block_number >= ? AND block_number <= ?",
    );
    private selectFills = db.prepare<[number, number, number]>(
        "SELECT collection_id, contract_address AS contract, token_id, order_side, maker, taker, amount, block_number, tx_hash, log_index " +
            "FROM fills WHERE chain_id = ? AND block_number >= ? AND block_number <= ?",
    );
    private insertActivity = db.prepare<
        [
            number,
            number,
            string,
            string,
            string,
            string | null,
            string | null,
            string | null,
            number,
            string,
            number,
        ]
    >(
        "INSERT OR IGNORE INTO activities " +
            "(chain_id, collection_id, kind, contract_address, token_id, from_address, to_address, amount, block_number, tx_hash, log_index, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
    );

    async handleDomainSync(context: DomainSyncContext): Promise<void> {
        const { chainId, fromBlock, toBlock } = context;
        if (fromBlock > toBlock) return;

        const transferResult = this.persistTransferActivities(
            chainId,
            fromBlock,
            toBlock,
        );
        const fillResult = this.persistFillActivities(
            chainId,
            fromBlock,
            toBlock,
        );
        const inserted = transferResult.inserted + fillResult.inserted;

        logger.debug("Activity domain sync applied", {
            component: "ActivityDomain",
            action: "handleDomainSync",
            chainId,
            fromBlock,
            toBlock,
            transfers: transferResult.rows,
            fills: fillResult.rows,
            inserted,
        });
    }

    private persistTransferActivities(
        chainId: number,
        fromBlock: number,
        toBlock: number,
    ): { rows: number; inserted: number } {
        const rows = this.selectTransfers.all(
            chainId,
            fromBlock,
            toBlock,
        ) as TransferRow[];

        let inserted = 0;
        for (const row of rows) {
            const result = this.insertActivity.run(
                chainId,
                row.collection_id,
                ACTIVITY_KIND.Transfer,
                row.contract.toLowerCase(),
                row.token_id,
                row.from_address?.toLowerCase() ?? null,
                row.to_address?.toLowerCase() ?? null,
                row.amount,
                row.block_number,
                row.tx_hash,
                row.log_index,
            );
            inserted += result.changes;
        }

        return { rows: rows.length, inserted };
    }

    private persistFillActivities(
        chainId: number,
        fromBlock: number,
        toBlock: number,
    ): { rows: number; inserted: number } {
        const fillRows = this.selectFills.all(
            chainId,
            fromBlock,
            toBlock,
        ) as FillRow[];

        let inserted = 0;
        for (const row of fillRows) {
            const maker = row.maker?.toLowerCase() ?? null;
            const taker = row.taker?.toLowerCase() ?? null;
            const side = row.order_side;
            const from =
                side === "sell" ? maker : side === "buy" ? taker : maker;
            const to = side === "sell" ? taker : side === "buy" ? maker : taker;

            const result = this.insertActivity.run(
                chainId,
                row.collection_id,
                ACTIVITY_KIND.Fill,
                row.contract.toLowerCase(),
                row.token_id,
                from,
                to,
                row.amount,
                row.block_number,
                row.tx_hash,
                row.log_index,
            );
            inserted += result.changes;
        }

        return { rows: fillRows.length, inserted };
    }
}
