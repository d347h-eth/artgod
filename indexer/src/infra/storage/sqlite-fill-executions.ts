import { db } from "@artgod/shared/database";
import { isDeepStrictEqual } from "node:util";
import {
    prepareFillExecution,
    type FillExecution,
} from "@artgod/shared/market-data/fills";

/** Called inside the sync write transaction. Immutable protocol facts can be
 * re-attributed to another tracked collection, but cannot change on replay. */
export function persistFillExecution(input: {
    executionId: string;
    chainId: number;
    kind: string;
    txHash: string;
    logIndex: number;
    blockNumber: number;
    blockHash: string;
    blockTimestamp: number;
    execution: FillExecution;
}): void {
    const { payment, items } = prepareFillExecution(input.execution);
    const header = {
        id: input.executionId,
        chain_id: input.chainId,
        kind: input.kind,
        protocol_address: input.execution.protocolAddress,
        tx_hash: input.txHash.toLowerCase(),
        log_index: input.logIndex,
        block_number: input.blockNumber,
        block_hash: input.blockHash,
        block_timestamp: input.blockTimestamp,
        price_exclusion: payment.exclusion,
        total_price: payment.totalPrice,
        currency: payment.currency,
        nft_quantity: payment.nftQuantity,
    };
    const itemRows = items.map((item) => ({
        item_index: item.index,
        side: item.side,
        item_type: item.itemType,
        contract_address: item.contract,
        identifier: item.identifier,
        amount: item.amount,
        recipient: item.recipient,
        unit_offset: item.unitOffset,
    }));
    const existing = db
        .prepare<[string]>(
            `SELECT id, chain_id, kind, protocol_address, tx_hash, log_index,
                block_number, block_hash, block_timestamp, price_exclusion,
                total_price, currency, nft_quantity FROM fill_executions WHERE id=?`,
        )
        .get(input.executionId) as typeof header | undefined;
    if (existing) {
        const storedItems = db
            .prepare<[string]>(
                `SELECT item_index, side, item_type, contract_address, identifier,
                    amount, recipient, unit_offset FROM fill_execution_items
                 WHERE execution_id=? ORDER BY item_index`,
            )
            .all(input.executionId) as typeof itemRows;
        if (
            !isDeepStrictEqual(existing, header) ||
            !isDeepStrictEqual(storedItems, itemRows)
        )
            throw new Error("Conflicting immutable fill execution");
        return;
    }
    db.prepare(
        `INSERT INTO fill_executions (id, chain_id, kind, protocol_address, tx_hash, log_index, block_number, block_hash, block_timestamp, price_exclusion, total_price, currency, nft_quantity)
        VALUES (@id, @chain_id, @kind, @protocol_address, @tx_hash, @log_index, @block_number, @block_hash, @block_timestamp, @price_exclusion, @total_price, @currency, @nft_quantity)`,
    ).run(header);
    const insert =
        db.prepare(`INSERT INTO fill_execution_items (execution_id, item_index, side, item_type, contract_address, identifier, amount, recipient, unit_offset)
        VALUES (@executionId, @item_index, @side, @item_type, @contract_address, @identifier, @amount, @recipient, @unit_offset)`);
    for (const item of itemRows)
        insert.run({ executionId: input.executionId, ...item });
}
