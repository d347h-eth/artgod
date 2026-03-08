import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import {
    ORDER_LOCAL_TOKEN_SET_STATUS,
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_SOURCE_SCOPE_KIND,
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
} from "../../domain/orders.js";
import type {
    OrderUpdateByIdPayload,
    OrderUpdateByMakerPayload,
    OrderUpsertPayload,
} from "../../domain/order-jobs.js";
import type {
    DomainSyncContext,
    OrdersDomainPort,
} from "../../ports/domain-handlers.js";
import type {
    OrderLocalTokenSetStatus,
    OrderRecord,
    OrderSeaportDataSourceKind,
    SeaportOrderData,
    OrderSourceScopeKind,
    OrderSourceStatus,
    OrderStatus,
} from "../../domain/orders.js";
import type { TokenSetSchema } from "../../domain/token-sets.js";

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
    source_scope_kind: string;
    source_criteria_root: string | null;
    source_schema_json: string | null;
    local_token_set_status: string;
    token_set_id: string | null;
    token_set_schema_hash: string | null;
    price: string | null;
    currency: string | null;
    valid_from: number | null;
    valid_until: number | null;
    fillability_status: string;
    source_status: string;
    seaport_data_json: string | null;
    seaport_data_source_kind: string | null;
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
    "SELECT id, chain_id, kind, side, source, maker, taker, contract_address AS contract, token_id, source_scope_kind, source_criteria_root, source_schema_json, local_token_set_status, token_set_id, token_set_schema_hash, price, currency, " +
    "valid_from, valid_until, fillability_status, source_status, seaport_data_json, seaport_data_source_kind, block_number, tx_hash, log_index " +
    "FROM orders ";

export class SqliteOrdersDomain implements OrdersDomainPort {
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
        "SELECT id, chain_id, kind, side, source, maker, taker, contract_address AS contract, token_id, source_scope_kind, source_criteria_root, source_schema_json, local_token_set_status, token_set_id, token_set_schema_hash, price, currency, " +
            "valid_from, valid_until, fillability_status, source_status, seaport_data_json, seaport_data_source_kind, block_number, tx_hash, log_index " +
            "FROM orders WHERE chain_id = @chainId AND id = @orderId",
    );
    private selectMakerSellOrdersForToken =
        db.prepare<MakerSellOrdersForTokenParams>(
            SELECT_ORDER_FIELDS +
                "WHERE chain_id = @chainId AND kind = 'seaport' AND maker = @maker AND side = 'sell' " +
                "AND contract_address = @contract AND token_id = @tokenId " +
                "AND seaport_data_json IS NOT NULL",
        );
    private selectMakerWethBuyOrders = db.prepare<MakerWethBuyOrdersParams>(
        SELECT_ORDER_FIELDS +
            "WHERE chain_id = @chainId AND kind = 'seaport' AND maker = @maker AND side = 'buy' " +
            "AND currency = @currency " +
            "AND seaport_data_json IS NOT NULL",
    );
    private selectMakerSeaportOrders = db.prepare<MakerSeaportOrdersParams>(
        SELECT_ORDER_FIELDS +
            "WHERE chain_id = @chainId AND kind = 'seaport' AND maker = @maker " +
            "AND seaport_data_json IS NOT NULL",
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
        sourceScopeKind: OrderSourceScopeKind;
        sourceCriteriaRoot: string | null;
        sourceSchemaJson: string | null;
        localTokenSetStatus: OrderLocalTokenSetStatus;
        tokenSetId: string | null;
        tokenSetSchemaHash: string | null;
        price: string | null;
        currency: string | null;
        validFrom: number | null;
        validUntil: number | null;
        fillabilityStatus: OrderStatus;
        sourceStatus: OrderSourceStatus;
        seaportDataJson: string | null;
        seaportDataSourceKind: OrderSeaportDataSourceKind | null;
        rawRestData: string | null;
        rawStreamData: string | null;
    }>(
        "INSERT INTO orders (id, chain_id, kind, side, source, maker, taker, contract_address, token_id, source_scope_kind, source_criteria_root, source_schema_json, local_token_set_status, token_set_id, token_set_schema_hash, price, currency, valid_from, valid_until, fillability_status, source_status, seaport_data_json, seaport_data_source_kind, raw_rest_data, raw_stream_data) " +
            "VALUES (@id, @chainId, @kind, @side, @source, @maker, @taker, @contract, @tokenId, @sourceScopeKind, @sourceCriteriaRoot, @sourceSchemaJson, @localTokenSetStatus, @tokenSetId, @tokenSetSchemaHash, @price, @currency, @validFrom, @validUntil, @fillabilityStatus, @sourceStatus, @seaportDataJson, @seaportDataSourceKind, @rawRestData, @rawStreamData) " +
            "ON CONFLICT(id) DO UPDATE SET " +
            "kind = excluded.kind, " +
            "side = excluded.side, " +
            "source = excluded.source, " +
            "maker = excluded.maker, " +
            "taker = excluded.taker, " +
            "contract_address = excluded.contract_address, " +
            "token_id = excluded.token_id, " +
            "source_scope_kind = excluded.source_scope_kind, " +
            "source_criteria_root = excluded.source_criteria_root, " +
            "source_schema_json = excluded.source_schema_json, " +
            "local_token_set_status = excluded.local_token_set_status, " +
            "token_set_id = excluded.token_set_id, " +
            "token_set_schema_hash = excluded.token_set_schema_hash, " +
            "price = excluded.price, " +
            "currency = excluded.currency, " +
            "valid_from = excluded.valid_from, " +
            "valid_until = excluded.valid_until, " +
            "source_status = excluded.source_status, " +
            "seaport_data_json = COALESCE(excluded.seaport_data_json, orders.seaport_data_json), " +
            "seaport_data_source_kind = COALESCE(excluded.seaport_data_source_kind, orders.seaport_data_source_kind), " +
            "raw_rest_data = COALESCE(excluded.raw_rest_data, orders.raw_rest_data), " +
            "raw_stream_data = COALESCE(excluded.raw_stream_data, orders.raw_stream_data), " +
            "updated_at = CURRENT_TIMESTAMP",
    );

    constructor(wethAddress: string, validateOrder: SeaportOrderValidator) {
        this.wethAddress = wethAddress.toLowerCase();
        this.validateOrder = validateOrder;
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
            const order = mapOrderRow(row);
            if (row.kind === "seaport" && hasSeaportData(order)) {
                const validation = await this.validateOrder(order);
                finalStatus = validation.status;
                logger.debug("Orders validation result", {
                    component: "OrdersDomain",
                    action: "handleOrderUpdateById",
                    orderId: row.id,
                    chainId: row.chain_id,
                    status: validation.status,
                    reason: validation.reason,
                });
            } else if (row.kind === "seaport") {
                finalStatus = ORDER_STATUS.Invalid;
                logger.warn("Orders update-by-id missing canonical seaport data", {
                    component: "OrdersDomain",
                    action: "handleOrderUpdateById",
                    chainId: row.chain_id,
                    orderId: row.id,
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
        const sourceScopeKind =
            payload.sourceScopeKind ?? ORDER_SOURCE_SCOPE_KIND.Token;
        const rawSourceKind = payload.rawSourceKind ?? "stream";
        const existingRow = this.selectOrderById.get({
            chainId: payload.chainId,
            orderId: payload.orderId,
        }) as OrderRow | undefined;
        const existingOrder = existingRow ? mapOrderRow(existingRow) : null;
        const mergedSeaportData = mergeSeaportData(
            existingOrder?.seaportData ?? null,
            existingOrder?.seaportDataSourceKind ?? null,
            payload.seaportData ?? null,
            rawSourceKind,
        );
        const seaportDataSourceKind = resolveSeaportDataSourceKind(
            existingOrder?.seaportDataSourceKind ?? null,
            payload.seaportData ?? null,
            rawSourceKind,
        );
        const rawPayload = payload.rawPayload
            ? JSON.stringify(payload.rawPayload)
            : null;
        const rawStreamData =
            rawSourceKind === "stream" ? rawPayload : null;
        const rawRestData = rawSourceKind === "rest" ? rawPayload : null;
        const sourceSchemaJson = payload.sourceSchema
            ? JSON.stringify(payload.sourceSchema)
            : null;
        const seaportDataJson = mergedSeaportData
            ? JSON.stringify(mergedSeaportData)
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
            sourceScopeKind,
            sourceCriteriaRoot: payload.sourceCriteriaRoot ?? null,
            sourceSchemaJson,
            localTokenSetStatus:
                payload.localTokenSetStatus ??
                defaultLocalTokenSetStatus(sourceScopeKind),
            tokenSetId: payload.tokenSetId ?? null,
            tokenSetSchemaHash: payload.tokenSetSchemaHash ?? null,
            price: payload.price ?? null,
            currency: payload.currency ?? null,
            validFrom: payload.validFrom ?? null,
            validUntil: payload.validUntil ?? null,
            fillabilityStatus: ORDER_STATUS.Fillable,
            sourceStatus: payload.sourceStatus ?? ORDER_SOURCE_STATUS.Active,
            seaportDataJson,
            seaportDataSourceKind,
            rawRestData,
            rawStreamData,
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
        sourceScopeKind: row.source_scope_kind as OrderSourceScopeKind,
        sourceCriteriaRoot: row.source_criteria_root,
        sourceSchemaJson: row.source_schema_json,
        localTokenSetStatus:
            row.local_token_set_status as OrderLocalTokenSetStatus,
        tokenSetId: row.token_set_id,
        tokenSetSchemaHash: row.token_set_schema_hash,
        price: row.price,
        currency: row.currency,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
        fillabilityStatus:
            row.fillability_status as OrderRecord["fillabilityStatus"],
        sourceStatus: row.source_status as OrderRecord["sourceStatus"],
        seaportData: parseSeaportDataJson(row.seaport_data_json),
        seaportDataSourceKind:
            row.seaport_data_source_kind as OrderSeaportDataSourceKind | null,
        blockNumber: row.block_number,
        txHash: row.tx_hash,
        logIndex: row.log_index,
    };
}

function parseSeaportDataJson(value: string | null): SeaportOrderData | null {
    if (!value) return null;
    return JSON.parse(value) as SeaportOrderData;
}

function hasSeaportData(order: OrderRecord): boolean {
    return Boolean(order.seaportData);
}

function mergeSeaportData(
    existing: SeaportOrderData | null,
    existingSourceKind: OrderSeaportDataSourceKind | null,
    incoming: SeaportOrderData | null,
    incomingSourceKind: "stream" | "rest",
): SeaportOrderData | null {
    if (!incoming) {
        return existing;
    }

    if (
        incomingSourceKind === ORDER_SEAPORT_DATA_SOURCE_KIND.Rest &&
        existing &&
        existingSourceKind === ORDER_SEAPORT_DATA_SOURCE_KIND.Stream &&
        !incoming.signature &&
        existing.signature
    ) {
        return {
            ...incoming,
            signature: existing.signature,
        };
    }

    return incoming;
}

function resolveSeaportDataSourceKind(
    existing: OrderSeaportDataSourceKind | null,
    incoming: SeaportOrderData | null,
    incomingSourceKind: "stream" | "rest",
): OrderSeaportDataSourceKind | null {
    if (!incoming) {
        return existing;
    }

    if (incomingSourceKind === ORDER_SEAPORT_DATA_SOURCE_KIND.Stream) {
        return ORDER_SEAPORT_DATA_SOURCE_KIND.Stream;
    }

    if (existing === ORDER_SEAPORT_DATA_SOURCE_KIND.Stream) {
        return ORDER_SEAPORT_DATA_SOURCE_KIND.Stream;
    }

    return ORDER_SEAPORT_DATA_SOURCE_KIND.Rest;
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

function defaultLocalTokenSetStatus(
    sourceScopeKind: OrderSourceScopeKind,
): OrderLocalTokenSetStatus {
    if (sourceScopeKind === ORDER_SOURCE_SCOPE_KIND.Token) {
        return ORDER_LOCAL_TOKEN_SET_STATUS.None;
    }

    return ORDER_LOCAL_TOKEN_SET_STATUS.Unresolved;
}
