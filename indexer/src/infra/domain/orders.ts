import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { ORDER_SOURCE_STATUS, ORDER_STATUS } from "../../domain/orders.js";
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
import type {
    OrderRecord,
    OrderSourceStatus,
    OrderStatus,
} from "../../domain/orders.js";

type OrderRow = {
    id: string;
    chain_id: number;
    kind: string;
    side: "buy" | "sell" | null;
    source: string | null;
    maker: string;
    taker: string | null;
    contract: string;
    token_id: string | null;
    token_set_id: string | null;
    token_set_schema_hash: string | null;
    price: string | null;
    currency: string | null;
    valid_from: number | null;
    valid_until: number | null;
    fillability_status: string;
    source_status: string;
    raw_data: string | null;
    block_number: number | null;
    tx_hash: string | null;
    log_index: number | null;
};

type SeaportOrderValidator = (
    order: OrderRecord,
) => Promise<{ status: OrderStatus; reason: string }>;

type OrderIdentityParams = {
    chainId: number;
    orderId: string;
};

type OrderFillabilityStatusParams = OrderIdentityParams & {
    fillabilityStatus: OrderStatus;
};

type OrderSourceStatusParams = OrderIdentityParams & {
    sourceStatus: OrderSourceStatus;
};

type MakerSellOrdersForTokenParams = {
    chainId: number;
    maker: string;
    contract: string;
    tokenId: string;
};

type MakerWethBuyOrdersParams = {
    chainId: number;
    maker: string;
    currency: string;
};

type MakerSeaportOrdersParams = {
    chainId: number;
    maker: string;
};

const SELECT_ORDER_FIELDS =
    "SELECT id, chain_id, kind, side, source, maker, taker, contract_address AS contract, token_id, token_set_id, token_set_schema_hash, price, currency, " +
    "valid_from, valid_until, fillability_status, source_status, raw_data, block_number, tx_hash, log_index " +
    "FROM orders ";

export class SqliteOrdersDomain implements OrdersDomainPort {
    private readonly rpc: RpcProviderPort;
    private readonly conduits: ConduitRegistryPort;
    private readonly seaportConfig: { conduitController: string };
    private readonly wethAddress: string;
    private readonly validateOrder: SeaportOrderValidator;
    private updateOrderFillabilityStatus =
        db.prepare<OrderFillabilityStatusParams>(
            "UPDATE orders SET fillability_status = @fillabilityStatus, updated_at = CURRENT_TIMESTAMP " +
                "WHERE chain_id = @chainId AND id = @orderId",
        );
    private updateOrderSourceStatus = db.prepare<OrderSourceStatusParams>(
        "UPDATE orders SET source_status = @sourceStatus, updated_at = CURRENT_TIMESTAMP " +
            "WHERE chain_id = @chainId AND id = @orderId",
    );
    private selectOrderById = db.prepare<OrderIdentityParams>(
        "SELECT id, chain_id, kind, side, source, maker, taker, contract_address AS contract, token_id, token_set_id, token_set_schema_hash, price, currency, " +
            "valid_from, valid_until, fillability_status, source_status, raw_data, block_number, tx_hash, log_index " +
            "FROM orders WHERE chain_id = @chainId AND id = @orderId",
    );
    private selectMakerSellOrdersForToken =
        db.prepare<MakerSellOrdersForTokenParams>(
            SELECT_ORDER_FIELDS +
                "WHERE chain_id = @chainId AND kind = 'seaport' AND maker = @maker AND side = 'sell' " +
                "AND contract_address = @contract AND token_id = @tokenId AND raw_data IS NOT NULL",
        );
    private selectMakerWethBuyOrders = db.prepare<MakerWethBuyOrdersParams>(
        SELECT_ORDER_FIELDS +
            "WHERE chain_id = @chainId AND kind = 'seaport' AND maker = @maker AND side = 'buy' " +
            "AND currency = @currency AND raw_data IS NOT NULL",
    );
    private selectMakerSeaportOrders = db.prepare<MakerSeaportOrdersParams>(
        SELECT_ORDER_FIELDS +
            "WHERE chain_id = @chainId AND kind = 'seaport' AND maker = @maker AND raw_data IS NOT NULL",
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
        tokenId: string | null;
        tokenSetId: string | null;
        tokenSetSchemaHash: string | null;
        price: string | null;
        currency: string | null;
        validFrom: number | null;
        validUntil: number | null;
        fillabilityStatus: string;
        sourceStatus: string;
        rawData: string | null;
    }>(
        "INSERT INTO orders (id, chain_id, kind, side, source, maker, taker, contract_address, token_id, token_set_id, token_set_schema_hash, price, currency, valid_from, valid_until, fillability_status, source_status, raw_data) " +
            "VALUES (@id, @chainId, @kind, @side, @source, @maker, @taker, @contract, @tokenId, @tokenSetId, @tokenSetSchemaHash, @price, @currency, @validFrom, @validUntil, @fillabilityStatus, @sourceStatus, @rawData) " +
            "ON CONFLICT(id) DO UPDATE SET " +
            "kind = excluded.kind, " +
            "side = excluded.side, " +
            "source = excluded.source, " +
            "maker = excluded.maker, " +
            "taker = excluded.taker, " +
            "contract_address = excluded.contract_address, " +
            "token_id = excluded.token_id, " +
            "token_set_id = excluded.token_set_id, " +
            "token_set_schema_hash = excluded.token_set_schema_hash, " +
            "price = excluded.price, " +
            "currency = excluded.currency, " +
            "valid_from = excluded.valid_from, " +
            "valid_until = excluded.valid_until, " +
            "source_status = excluded.source_status, " +
            "raw_data = excluded.raw_data, " +
            "updated_at = CURRENT_TIMESTAMP",
    );

    constructor(
        rpc: RpcProviderPort,
        conduits: ConduitRegistryPort,
        seaportConfig: { conduitController: string },
        wethAddress: string,
        validateOrder?: SeaportOrderValidator,
    ) {
        this.rpc = rpc;
        this.conduits = conduits;
        this.seaportConfig = seaportConfig;
        this.wethAddress = wethAddress.toLowerCase();
        this.validateOrder =
            validateOrder ??
            ((order) =>
                validateSeaportOrder(
                    this.rpc,
                    this.conduits,
                    this.seaportConfig,
                    order,
                ));
    }

    async handleDomainSync(context: DomainSyncContext): Promise<void> {
        logger.debug("Orders domain sync ignored", {
            component: "OrdersDomain",
            action: "handleDomainSync",
            ...context,
            reason: "order-updates-flow-through-dedicated-jobs",
        });
    }

    async handleOrderUpdateByMaker(
        payload: OrderUpdateByMakerPayload,
    ): Promise<void> {
        const rows = this.selectMakerUpdateCandidates(payload);
        if (rows.length === 0) {
            logger.debug("Orders update-by-maker matched no candidate orders", {
                component: "OrdersDomain",
                action: "handleOrderUpdateByMaker",
                ...payload,
            });
            return;
        }

        let updated = 0;
        for (const row of rows) {
            const validation = await this.revalidateSeaportOrder(row);
            const result = this.updateOrderFillabilityStatus.run({
                fillabilityStatus: validation.status,
                chainId: payload.chainId,
                orderId: row.id,
            });
            updated += result.changes;
            logger.debug("Orders update-by-maker validation result", {
                component: "OrdersDomain",
                action: "handleOrderUpdateByMaker",
                chainId: payload.chainId,
                orderId: row.id,
                triggerReason: payload.reason,
                status: validation.status,
                reason: validation.reason,
            });
        }

        logger.debug("Orders update-by-maker applied", {
            component: "OrdersDomain",
            action: "handleOrderUpdateByMaker",
            ...payload,
            matchedOrders: rows.length,
            updated,
        });
    }

    async handleOrderUpdateById(
        payload: OrderUpdateByIdPayload,
    ): Promise<void> {
        if (payload.sourceStatus) {
            const result = this.updateOrderSourceStatus.run({
                sourceStatus: payload.sourceStatus,
                chainId: payload.chainId,
                orderId: payload.orderId,
            });

            logger.debug("Orders source update-by-id applied", {
                component: "OrdersDomain",
                action: "handleOrderUpdateById",
                chainId: payload.chainId,
                orderId: payload.orderId,
                reason: payload.reason,
                sourceStatus: payload.sourceStatus,
                updated: result.changes,
            });
            return;
        }

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
            const row = this.selectOrderById.get({
                chainId: payload.chainId,
                orderId: payload.orderId,
            }) as OrderRow | undefined;
            if (!row) {
                logger.warn("Orders update-by-id missing order", {
                    component: "OrdersDomain",
                    action: "handleOrderUpdateById",
                    ...payload,
                });
                return;
            }
            if (row.kind === "seaport" && row.raw_data) {
                const validation = await this.validateOrder(mapOrderRow(row));
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

        const result = this.updateOrderFillabilityStatus.run({
            fillabilityStatus: finalStatus,
            chainId: payload.chainId,
            orderId: payload.orderId,
        });

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
            tokenId: payload.tokenId ?? null,
            tokenSetId: payload.tokenSetId ?? null,
            tokenSetSchemaHash: payload.tokenSetSchemaHash ?? null,
            price: payload.price ?? null,
            currency: payload.currency ?? null,
            validFrom: payload.validFrom ?? null,
            validUntil: payload.validUntil ?? null,
            fillabilityStatus: ORDER_STATUS.Fillable,
            sourceStatus: payload.sourceStatus ?? ORDER_SOURCE_STATUS.Active,
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

    private selectMakerUpdateCandidates(
        payload: OrderUpdateByMakerPayload,
    ): OrderRow[] {
        const maker = payload.maker.toLowerCase();
        switch (payload.reason) {
            case "nft-transfer":
            case "item_sold":
            case "item_transferred":
                if (!payload.contract || payload.tokenId === undefined) {
                    logger.debug(
                        "Orders update-by-maker ignored (missing token scope)",
                        {
                            component: "OrdersDomain",
                            action: "handleOrderUpdateByMaker",
                            ...payload,
                        },
                    );
                    return [];
                }
                return this.selectMakerSellOrdersForToken.all({
                    chainId: payload.chainId,
                    maker,
                    contract: payload.contract.toLowerCase(),
                    tokenId: payload.tokenId,
                }) as OrderRow[];
            case "erc20-balance":
            case "approval-change":
                return this.selectMakerWethBuyOrders.all({
                    chainId: payload.chainId,
                    maker,
                    currency: this.wethAddress,
                }) as OrderRow[];
            case "order-counter":
                return this.selectMakerSeaportOrders.all({
                    chainId: payload.chainId,
                    maker,
                }) as OrderRow[];
            default:
                return assertNeverReason(payload.reason);
        }
    }

    private async revalidateSeaportOrder(
        row: OrderRow,
    ): Promise<{ status: OrderStatus; reason: string }> {
        return this.validateOrder(mapOrderRow(row));
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
        tokenSetId: row.token_set_id,
        tokenSetSchemaHash: row.token_set_schema_hash,
        price: row.price,
        currency: row.currency,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        fillabilityStatus:
            row.fillability_status as OrderRecord["fillabilityStatus"],
        sourceStatus: row.source_status as OrderRecord["sourceStatus"],
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

function assertNeverReason(reason: never): never {
    throw new Error(`Unsupported order update-by-maker reason: ${reason}`);
}
