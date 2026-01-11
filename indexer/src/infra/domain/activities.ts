import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { ACTIVITY_KIND } from "../../domain/activities.js";
import type {
    ActivityDomainPort,
    DomainSyncContext,
} from "../../ports/domain-handlers.js";

type TransferRow = {
    contract: string;
    token_id: string;
    from_address: string;
    to_address: string;
    amount: string;
    block_number: number;
    tx_hash: string;
    log_index: number;
};

export class SqliteActivityDomain implements ActivityDomainPort {
    private selectTransfers = db.prepare<[number, number, number]>(
        "SELECT contract, token_id, from_address, to_address, amount, block_number, tx_hash, log_index " +
            "FROM nft_transfer_events WHERE chain_id = ? AND block_number >= ? AND block_number <= ?",
    );
    private insertActivity = db.prepare<
        [
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
            "(chain_id, kind, contract, token_id, from_address, to_address, amount, block_number, tx_hash, log_index, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
    );

    async handleDomainSync(context: DomainSyncContext): Promise<void> {
        const { chainId, fromBlock, toBlock } = context;
        if (fromBlock > toBlock) return;

        const rows = this.selectTransfers.all(
            chainId,
            fromBlock,
            toBlock,
        ) as TransferRow[];

        let inserted = 0;
        for (const row of rows) {
            const result = this.insertActivity.run(
                chainId,
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

        logger.debug("Activity domain sync applied", {
            component: "ActivityDomain",
            action: "handleDomainSync",
            chainId,
            fromBlock,
            toBlock,
            transfers: rows.length,
            inserted,
        });
    }
}
