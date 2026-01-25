import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { ORDER_STATUS } from "../../domain/orders.js";
import type {
    OrderUpdateByIdPayload,
    OrderUpdateByMakerPayload,
    OrderUpsertPayload,
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
    private updateOrderStatus = db.prepare<[string, number, string]>(
        "UPDATE orders SET fillability_status = ?, updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = ? AND id = ?",
    );
    private upsertOrder = db.prepare<{
        id: string;
        chainId: number;
        kind: string;
        side: string;
        source: string;
        maker: string;
        taker: string | null;
        contract: string;
        tokenId: string;
        price: string | null;
        currency: string | null;
        validFrom: number | null;
        validUntil: number | null;
        fillabilityStatus: string;
        rawData: string | null;
    }>(
        "INSERT INTO orders (id, chain_id, kind, side, source, maker, taker, contract, token_id, price, currency, valid_from, valid_until, fillability_status, raw_data) " +
            "VALUES (@id, @chainId, @kind, @side, @source, @maker, @taker, @contract, @tokenId, @price, @currency, @validFrom, @validUntil, @fillabilityStatus, @rawData) " +
            "ON CONFLICT(id) DO UPDATE SET " +
            "kind = excluded.kind, " +
            "side = excluded.side, " +
            "source = excluded.source, " +
            "maker = excluded.maker, " +
            "taker = excluded.taker, " +
            "contract = excluded.contract, " +
            "token_id = excluded.token_id, " +
            "price = excluded.price, " +
            "currency = excluded.currency, " +
            "valid_from = excluded.valid_from, " +
            "valid_until = excluded.valid_until, " +
            "raw_data = excluded.raw_data, " +
            "updated_at = CURRENT_TIMESTAMP",
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
        const status =
            payload.reason === "fill"
                ? ORDER_STATUS.Filled
                : payload.reason === "cancel"
                  ? ORDER_STATUS.Cancelled
                  : payload.reason === "order"
                    ? ORDER_STATUS.Fillable
                    : null;

        if (!status) {
            logger.debug("Orders update-by-id ignored", {
                component: "OrdersDomain",
                action: "handleOrderUpdateById",
                ...payload,
            });
            return;
        }

        const result = this.updateOrderStatus.run(
            status,
            payload.chainId,
            payload.orderId,
        );

        logger.debug("Orders update-by-id applied", {
            component: "OrdersDomain",
            action: "handleOrderUpdateById",
            ...payload,
            status,
            updated: result.changes,
        });
    }

    async handleOrderUpsert(payload: OrderUpsertPayload): Promise<void> {
        const rawData = payload.rawData
            ? JSON.stringify(payload.rawData)
            : null;
        const result = this.upsertOrder.run({
            id: payload.orderId,
            chainId: payload.chainId,
            kind: payload.kind,
            side: payload.side,
            source: payload.source,
            maker: payload.maker,
            taker: payload.taker ?? null,
            contract: payload.contract,
            tokenId: payload.tokenId,
            price: payload.price ?? null,
            currency: payload.currency ?? null,
            validFrom: payload.validFrom ?? null,
            validUntil: payload.validUntil ?? null,
            fillabilityStatus: ORDER_STATUS.Fillable,
            rawData,
        });

        logger.debug("Orders upsert applied", {
            component: "OrdersDomain",
            action: "handleOrderUpsert",
            orderId: payload.orderId,
            chainId: payload.chainId,
            kind: payload.kind,
            side: payload.side,
            updated: result.changes,
        });
    }
}
