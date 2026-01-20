import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { ORDER_STATUS } from "../../domain/orders.js";
import type {
    OrderUpdateByIdPayload,
    OrderUpdateByMakerPayload,
} from "../../domain/order-jobs.js";
import type {
    DomainSyncContext,
    OrdersDomainPort,
} from "../../ports/domain-handlers.js";

type TransferRow = {
    contract: string;
    from_address: string;
    token_id: string;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class SqliteOrdersDomain implements OrdersDomainPort {
    private selectTransfers = db.prepare<[number, number, number, string]>(
        "SELECT contract, from_address, token_id FROM nft_transfer_events " +
            "WHERE chain_id = ? AND block_number >= ? AND block_number <= ? AND from_address != ?",
    );
    private invalidateOrders = db.prepare<
        [string, number, string, string, string, string]
    >(
        "UPDATE orders SET fillability_status = ?, updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = ? AND maker = ? AND contract = ? AND token_id = ? " +
            "AND fillability_status != ?",
    );

    async handleDomainSync(context: DomainSyncContext): Promise<void> {
        const { chainId, fromBlock, toBlock } = context;
        if (fromBlock > toBlock) return;

        const rows = this.selectTransfers.all(
            chainId,
            fromBlock,
            toBlock,
            ZERO_ADDRESS,
        ) as TransferRow[];

        const uniqueKeys = new Set<string>();
        for (const row of rows) {
            const maker = row.from_address.toLowerCase();
            const contract = row.contract.toLowerCase();
            const tokenId = row.token_id;
            uniqueKeys.add(`${maker}:${contract}:${tokenId}`);
        }

        let invalidated = 0;
        for (const key of uniqueKeys) {
            const [maker, contract, tokenId] = key.split(":");
            if (!maker || !contract || tokenId === undefined) continue;
            const result = this.invalidateOrders.run(
                ORDER_STATUS.NoBalance,
                chainId,
                maker,
                contract,
                tokenId,
                ORDER_STATUS.NoBalance,
            );
            invalidated += result.changes;
        }

        logger.debug("Orders domain sync applied", {
            component: "OrdersDomain",
            action: "handleDomainSync",
            chainId,
            fromBlock,
            toBlock,
            transfers: rows.length,
            invalidatedOrders: invalidated,
        });
    }

    async handleOrderUpdateByMaker(
        payload: OrderUpdateByMakerPayload,
    ): Promise<void> {
        // Maker triggers indicate fillability changed (not an explicit cancel).
        logger.debug("Orders update-by-maker received", {
            component: "OrdersDomain",
            action: "handleOrderUpdateByMaker",
            ...payload,
        });
    }

    async handleOrderUpdateById(
        payload: OrderUpdateByIdPayload,
    ): Promise<void> {
        // Order updates by id handle explicit cancels/fills or on-chain order creation.
        logger.debug("Orders update-by-id received", {
            component: "OrdersDomain",
            action: "handleOrderUpdateById",
            ...payload,
        });
    }
}
