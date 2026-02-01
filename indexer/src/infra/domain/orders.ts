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
import type { ConduitRegistryPort } from "../../ports/conduits.js";
import type { RpcProviderPort } from "../../ports/rpc.js";
import { validateSeaportOrder } from "../../application/offchain/seaport-validate.js";
import type { OrderRecord, OrderStatus } from "../../domain/orders.js";

type TransferRow = {
    contract: string;
    from_address: string;
    token_id: string;
};

type OrderRow = {
    id: string;
    chain_id: number;
    kind: string;
    side: "buy" | "sell" | null;
    source: string | null;
    maker: string;
    taker: string | null;
    contract: string;
    token_id: string;
    price: string | null;
    currency: string | null;
    valid_from: number | null;
    valid_until: number | null;
    fillability_status: string;
    raw_data: string | null;
    block_number: number | null;
    tx_hash: string | null;
    log_index: number | null;
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export class SqliteOrdersDomain implements OrdersDomainPort {
    private readonly rpc: RpcProviderPort;
    private readonly conduits: ConduitRegistryPort;
    private readonly seaportConfig: { conduitController: string };
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
    private selectOrderById = db.prepare<[number, string]>(
        "SELECT id, chain_id, kind, side, source, maker, taker, contract, token_id, price, currency, " +
            "valid_from, valid_until, fillability_status, raw_data, block_number, tx_hash, log_index " +
            "FROM orders WHERE chain_id = ? AND id = ?",
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

    constructor(
        rpc: RpcProviderPort,
        conduits: ConduitRegistryPort,
        seaportConfig: { conduitController: string },
    ) {
        this.rpc = rpc;
        this.conduits = conduits;
        this.seaportConfig = seaportConfig;
    }

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
        const status = statusFromReason(payload.reason);

        if (!status) {
            logger.debug("Orders update-by-id ignored", {
                component: "OrdersDomain",
                action: "handleOrderUpdateById",
                ...payload,
            });
            return;
        }

        let finalStatus: OrderStatus = status;
        if (payload.reason === "order") {
            const row = this.selectOrderById.get(
                payload.chainId,
                payload.orderId,
            ) as OrderRow | undefined;
            if (!row) {
                logger.warn("Orders update-by-id missing order", {
                    component: "OrdersDomain",
                    action: "handleOrderUpdateById",
                    ...payload,
                });
                return;
            }
            if (row.kind === "seaport" && row.raw_data) {
                const validation = await validateSeaportOrder(
                    this.rpc,
                    this.conduits,
                    this.seaportConfig,
                    mapOrderRow(row),
                );
                finalStatus = validation.status;
                logger.debug("Orders validation result", {
                    component: "OrdersDomain",
                    action: "handleOrderUpdateById",
                    orderId: row.id,
                    chainId: row.chain_id,
                    status: validation.status,
                    reason: validation.reason,
                });
            }
        }

        const result = this.updateOrderStatus.run(
            finalStatus,
            payload.chainId,
            payload.orderId,
        );

        logger.debug("Orders update-by-id applied", {
            component: "OrdersDomain",
            action: "handleOrderUpdateById",
            ...payload,
            status: finalStatus,
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

function mapOrderRow(row: OrderRow): OrderRecord {
    return {
        id: row.id,
        chainId: row.chain_id,
        kind: row.kind,
        side: row.side,
        source: row.source,
        maker: row.maker,
        taker: row.taker,
        contract: row.contract,
        tokenId: row.token_id,
        price: row.price,
        currency: row.currency,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        fillabilityStatus:
            row.fillability_status as OrderRecord["fillabilityStatus"],
        rawData: row.raw_data,
        blockNumber: row.block_number,
        txHash: row.tx_hash,
        logIndex: row.log_index,
    };
}

function statusFromReason(
    reason: OrderUpdateByIdPayload["reason"],
): OrderStatus | null {
    switch (reason) {
        case "fill":
            return ORDER_STATUS.Filled;
        case "cancel":
            return ORDER_STATUS.Cancelled;
        case "order":
            return ORDER_STATUS.Fillable;
        default:
            return null;
    }
}
