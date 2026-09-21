import { db } from "@artgod/shared/database";
import { zeroAddress } from "viem";
import { SqliteDailyListingPrices } from "../storage/sqlite-daily-listing-prices.js";
import { MARKET_DATA_STORAGE_POLICY as STORAGE_POLICY } from "@artgod/shared/market-data/storage-policy";
import {
    admitsOrderObservation,
    isTerminalSourceStatus,
    isTerminalRetirement,
    ORDER_RETIREMENT_REASON,
} from "../../domain/order-retention.js";
import {
    getDefaultDebugPayloadPersistenceConfig,
    type DebugPayloadPersistenceConfig,
} from "@artgod/shared/config/debug-payload-persistence";
import { logger } from "@artgod/shared/utils";
import { CollectionRecord } from "../../domain/collections.js";
import {
    GLOBAL_MAKER_TRIGGER_REASON,
    MAKER_TRIGGER_SCOPE,
} from "../../domain/maker-triggers.js";
import {
    ORDER_LOCAL_TOKEN_SET_STATUS,
    ORDER_REVALIDATABLE_FILLABILITY_STATUS,
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_SOURCE_SCOPE_KIND,
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
    resolveOrderValidityState,
} from "../../domain/orders.js";
import type {
    OrderUpdateByIdPayload,
    OrderUpdateByMakerPayload,
    OrderUpsertPayload,
} from "../../domain/order-jobs.js";
import type {
    DomainSyncContext,
    OrderUpdateByMakerRuntimeContext,
    OrdersDomainPort,
} from "../../ports/domain-handlers.js";
import type {
    OrderLocalTokenSetStatus,
    OrderRecord,
    OrderSeaportDataSourceKind,
    OrderValidityState,
    SeaportOrderData,
    OrderSourceScopeKind,
    OrderSourceStatus,
    OrderStatus,
} from "../../domain/orders.js";
import type { TokenSetSchema } from "../../domain/token-sets.js";
import {
    ORDER_UPDATE_BY_MAKER_LOG_CONTEXT,
    ORDER_UPDATE_BY_MAKER_LOG_MESSAGE,
    ORDER_UPDATE_BY_MAKER_REPORTING_BUCKET,
    ORDER_UPDATE_BY_MAKER_REPORTING_LIMIT,
} from "./order-update-by-maker-reporting.js";

type OrderRow = {
    id: string;
    chain_id: number;
    collection_id: number;
    kind: string;
    side: "buy" | "sell" | null;
    source: string | null;
    maker: string;
    taker: string | null;
    contract: string;
    token_id: string | null;
    source_scope_kind: string;
    source_criteria_root: string | null;
    source_encoded_token_ids: string | null;
    source_schema_json: string | null;
    local_token_set_status: string;
    token_set_id: string | null;
    token_set_schema_hash: string | null;
    quantity: string | null;
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
    observed_at: number;
    validated_at: number;
    state_revision: number;
};

type CollectionAnchorRow = {
    bootstrap_anchor_block: number | null;
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

type MakerSellOrdersForTokenParams = {
    chainId: number;
    collectionId: number;
    maker: string;
    tokenId: string;
} & ActiveRevalidatableOrderParams;

type MakerSellOrdersForCollectionParams = {
    chainId: number;
    collectionId: number;
    maker: string;
} & ActiveRevalidatableOrderParams;

type MakerWethBuyOrdersParams = {
    chainId: number;
    maker: string;
    currency: string;
} & ActiveRevalidatableOrderParams;

type MakerSeaportOrdersParams = {
    chainId: number;
    maker: string;
} & ActiveRevalidatableOrderParams;

type ActiveRevalidatableOrderParams = {
    nowSeconds: number;
    afterId: string;
    batchLimit: number;
    sourceStatus: OrderSourceStatus;
    fillableStatus: OrderStatus;
    noBalanceStatus: OrderStatus;
    noApprovalStatus: OrderStatus;
};

type OrderUpdateByMakerLogContext = {
    component: typeof ORDER_UPDATE_BY_MAKER_LOG_CONTEXT.Component;
    action: typeof ORDER_UPDATE_BY_MAKER_LOG_CONTEXT.Action;
    chainId: number;
    scope: OrderUpdateByMakerPayload["scope"];
    maker: string;
    reason: OrderUpdateByMakerPayload["reason"];
    blockNumber: number | null;
    blockHash: string | null;
    txHash: string | null;
    logIndex: number | null;
    collectionId: number | null;
    tokenId: string | null;
    jobId: string | null;
    attempt: number | null;
    scheduledAt: number | null;
    traceId: string | null;
    consumerName: string | null;
};

type OrderRowsProfile = {
    count: number;
    sourceStatuses: Record<string, number>;
    fillabilityStatuses: Record<string, number>;
    sides: Record<string, number>;
    collections: Record<string, number>;
    validity: Partial<Record<OrderValidityState, number>>;
};

type ValidationSummary = {
    statuses: Record<string, number>;
    reasons: Record<string, number>;
    slowest: SlowOrderValidation[];
};

type SlowOrderValidation = {
    orderId: string;
    collectionId: number;
    side: string | null;
    sourceStatus: string;
    fillabilityStatus: string;
    durationMs: number;
    status: OrderStatus;
    reason: string;
};

type TimedOrderValidation = {
    status: OrderStatus;
    reason: string;
    durationMs: number;
};

const SELECT_ORDER_FIELDS =
    "SELECT id, chain_id, collection_id, kind, side, source, maker, taker, contract_address AS contract, token_id, source_scope_kind, source_criteria_root, source_encoded_token_ids, source_schema_json, local_token_set_status, token_set_id, token_set_schema_hash, quantity, price, currency, " +
    "valid_from, valid_until, fillability_status, source_status, seaport_data_json, seaport_data_source_kind, block_number, tx_hash, log_index, observed_at, validated_at, state_revision " +
    "FROM orders ";

const ACTIVE_REVALIDATABLE_ORDER_FILTER =
    "AND source_status = @sourceStatus " +
    "AND (valid_until IS NULL OR valid_until > @nowSeconds) AND id > @afterId " +
    "AND fillability_status IN (@fillableStatus, @noBalanceStatus, @noApprovalStatus) ";

export class SqliteOrdersDomain implements OrdersDomainPort {
    private readonly listingPrices: SqliteDailyListingPrices;
    private readonly wethAddress: string;
    private readonly validateOrder: SeaportOrderValidator;
    private updateOrderFillabilityStatus =
        db.prepare<OrderFillabilityStatusParams>(
            "UPDATE orders SET fillability_status = @fillabilityStatus, state_revision = state_revision + 1, updated_at = CURRENT_TIMESTAMP " +
                "WHERE chain_id = @chainId AND id = @orderId AND fillability_status IS NOT @fillabilityStatus",
        );
    private selectOrderById = db.prepare<OrderIdentityParams>(
        "SELECT id, chain_id, collection_id, kind, side, source, maker, taker, contract_address AS contract, token_id, source_scope_kind, source_criteria_root, source_encoded_token_ids, source_schema_json, local_token_set_status, token_set_id, token_set_schema_hash, quantity, price, currency, " +
            "valid_from, valid_until, fillability_status, source_status, seaport_data_json, seaport_data_source_kind, block_number, tx_hash, log_index, observed_at, validated_at, state_revision " +
            "FROM orders WHERE chain_id = @chainId AND id = @orderId",
    );
    private selectMakerSellOrdersForToken =
        db.prepare<MakerSellOrdersForTokenParams>(
            SELECT_ORDER_FIELDS +
                "WHERE chain_id = @chainId AND kind = 'seaport' AND maker = @maker AND side = 'sell' " +
                "AND collection_id = @collectionId AND token_id = @tokenId " +
                ACTIVE_REVALIDATABLE_ORDER_FILTER +
                "AND seaport_data_json IS NOT NULL ORDER BY id LIMIT @batchLimit",
        );
    private selectMakerSellOrdersForCollection =
        db.prepare<MakerSellOrdersForCollectionParams>(
            SELECT_ORDER_FIELDS +
                "WHERE chain_id = @chainId AND kind = 'seaport' AND maker = @maker AND side = 'sell' " +
                "AND collection_id = @collectionId " +
                ACTIVE_REVALIDATABLE_ORDER_FILTER +
                "AND seaport_data_json IS NOT NULL ORDER BY id LIMIT @batchLimit",
        );
    private selectMakerWethBuyOrders = db.prepare<MakerWethBuyOrdersParams>(
        SELECT_ORDER_FIELDS +
            "WHERE chain_id = @chainId AND kind = 'seaport' AND maker = @maker AND side = 'buy' " +
            "AND currency = @currency " +
            ACTIVE_REVALIDATABLE_ORDER_FILTER +
            "AND seaport_data_json IS NOT NULL ORDER BY id LIMIT @batchLimit",
    );
    private selectMakerSeaportOrders = db.prepare<MakerSeaportOrdersParams>(
        SELECT_ORDER_FIELDS +
            "WHERE chain_id = @chainId AND kind = 'seaport' AND maker = @maker " +
            ACTIVE_REVALIDATABLE_ORDER_FILTER +
            "AND seaport_data_json IS NOT NULL ORDER BY id LIMIT @batchLimit",
    );
    private selectCollectionAnchor = db.prepare<[number, number]>(
        "SELECT bootstrap_anchor_block FROM collections WHERE chain_id = ? AND collection_id = ? LIMIT 1",
    );
    private upsertOrder = db.prepare<{
        id: string;
        chainId: number;
        collectionId: number;
        kind: string;
        side: string;
        source: string;
        maker: string;
        taker: string | null;
        contract: string;
        tokenId: string | null;
        sourceScopeKind: OrderSourceScopeKind;
        sourceCriteriaRoot: string | null;
        sourceEncodedTokenIds: string | null;
        sourceSchemaJson: string | null;
        localTokenSetStatus: OrderLocalTokenSetStatus;
        tokenSetId: string | null;
        tokenSetSchemaHash: string | null;
        quantity: string;
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
        observedAt: number;
        protocolAddress: string | null;
        expectedRevision: number;
    }>(
        "INSERT INTO orders (id, chain_id, collection_id, kind, side, source, maker, taker, contract_address, token_id, source_scope_kind, source_criteria_root, source_encoded_token_ids, source_schema_json, local_token_set_status, token_set_id, token_set_schema_hash, quantity, price, currency, valid_from, valid_until, fillability_status, source_status, seaport_data_json, seaport_data_source_kind, raw_rest_data, raw_stream_data, observed_at, protocol_address) " +
            "VALUES (@id, @chainId, @collectionId, @kind, @side, @source, @maker, @taker, @contract, @tokenId, @sourceScopeKind, @sourceCriteriaRoot, @sourceEncodedTokenIds, @sourceSchemaJson, @localTokenSetStatus, @tokenSetId, @tokenSetSchemaHash, @quantity, @price, @currency, @validFrom, @validUntil, @fillabilityStatus, @sourceStatus, @seaportDataJson, @seaportDataSourceKind, @rawRestData, @rawStreamData, @observedAt, @protocolAddress) " +
            "ON CONFLICT(id) DO UPDATE SET " +
            "collection_id = excluded.collection_id, " +
            "kind = excluded.kind, " +
            "side = excluded.side, " +
            "source = excluded.source, " +
            "maker = excluded.maker, " +
            "taker = excluded.taker, " +
            "contract_address = excluded.contract_address, " +
            "token_id = excluded.token_id, " +
            "source_scope_kind = excluded.source_scope_kind, " +
            "source_criteria_root = excluded.source_criteria_root, " +
            "source_encoded_token_ids = excluded.source_encoded_token_ids, " +
            "source_schema_json = excluded.source_schema_json, " +
            "local_token_set_status = excluded.local_token_set_status, " +
            "token_set_id = excluded.token_set_id, " +
            "token_set_schema_hash = excluded.token_set_schema_hash, " +
            "quantity = excluded.quantity, " +
            "price = excluded.price, " +
            "currency = excluded.currency, " +
            "valid_from = excluded.valid_from, " +
            "valid_until = excluded.valid_until, " +
            "source_status = excluded.source_status, " +
            "seaport_data_json = COALESCE(excluded.seaport_data_json, orders.seaport_data_json), " +
            "seaport_data_source_kind = COALESCE(excluded.seaport_data_source_kind, orders.seaport_data_source_kind), " +
            "raw_rest_data = COALESCE(excluded.raw_rest_data, orders.raw_rest_data), " +
            "raw_stream_data = COALESCE(excluded.raw_stream_data, orders.raw_stream_data), " +
            "observed_at = MAX(observed_at, excluded.observed_at), protocol_address=excluded.protocol_address, " +
            "state_revision = state_revision + 1, updated_at = CURRENT_TIMESTAMP " +
            "WHERE orders.chain_id=excluded.chain_id AND orders.state_revision=@expectedRevision AND " +
            "(kind,side,source,maker,taker,contract_address,token_id,source_scope_kind,source_criteria_root,source_encoded_token_ids,source_schema_json,local_token_set_status,token_set_id,token_set_schema_hash,quantity,price,currency,valid_from,valid_until,source_status,seaport_data_json,seaport_data_source_kind,raw_rest_data,raw_stream_data) IS NOT " +
            "(excluded.kind,excluded.side,excluded.source,excluded.maker,excluded.taker,excluded.contract_address,excluded.token_id,excluded.source_scope_kind,excluded.source_criteria_root,excluded.source_encoded_token_ids,excluded.source_schema_json,excluded.local_token_set_status,excluded.token_set_id,excluded.token_set_schema_hash,excluded.quantity,excluded.price,excluded.currency,excluded.valid_from,excluded.valid_until,excluded.source_status,COALESCE(excluded.seaport_data_json,orders.seaport_data_json),COALESCE(excluded.seaport_data_source_kind,orders.seaport_data_source_kind),COALESCE(excluded.raw_rest_data,orders.raw_rest_data),COALESCE(excluded.raw_stream_data,orders.raw_stream_data))",
    );

    constructor(
        wethAddress: string,
        validateOrder: SeaportOrderValidator,
        private debugPayloads: DebugPayloadPersistenceConfig = getDefaultDebugPayloadPersistenceConfig(),
        private readonly nowSeconds = () => Math.floor(Date.now() / 1000),
    ) {
        this.wethAddress = wethAddress.toLowerCase();
        this.validateOrder = validateOrder;
        this.listingPrices = new SqliteDailyListingPrices(db.raw, [
            zeroAddress,
            this.wethAddress,
        ]);
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
        context?: OrderUpdateByMakerRuntimeContext,
    ): Promise<void> {
        // Keyset batches close the SQLite reader before awaiting RPC; no lifetime snapshot pins the WAL.
        let afterId: string | null = "";
        while (afterId !== null)
            afterId = await this.processMakerBatch(payload, context, afterId);
    }

    private async processMakerBatch(
        payload: OrderUpdateByMakerPayload,
        context: OrderUpdateByMakerRuntimeContext | undefined,
        afterId: string,
    ): Promise<string | null> {
        const startedAt = Date.now();
        const selectedRows = this.selectMakerUpdateCandidates(payload, afterId);
        const nextId =
            selectedRows.length === STORAGE_POLICY.maintenanceBatchRows
                ? selectedRows[selectedRows.length - 1]!.id
                : null;
        const rows = this.filterCurrentStateRows(
            payload.chainId,
            selectedRows,
            payload.blockNumber,
        );
        const logContext = buildOrderUpdateByMakerLogContext(payload, context);
        const candidateOrders = selectedRows.length;
        const currentStateCandidateOrders = rows.length;
        const skippedBeforeAnchorOrders =
            candidateOrders - currentStateCandidateOrders;
        const nowSeconds = Math.floor(startedAt / 1000);

        if (rows.length === 0) {
            logger.debug(ORDER_UPDATE_BY_MAKER_LOG_MESSAGE.Completed, {
                ...logContext,
                durationMs: Date.now() - startedAt,
                candidateOrders,
                currentStateCandidateOrders,
                skippedBeforeAnchorOrders,
                candidateProfile: profileOrderRows(selectedRows, nowSeconds),
                currentStateCandidateProfile: profileOrderRows(
                    rows,
                    nowSeconds,
                ),
                validatedOrders: 0,
                updated: 0,
                validation: createValidationSummary(),
            });
            return nextId;
        }

        logger.info(ORDER_UPDATE_BY_MAKER_LOG_MESSAGE.Started, {
            ...logContext,
            candidateOrders,
            currentStateCandidateOrders,
            skippedBeforeAnchorOrders,
            candidateProfile: profileOrderRows(selectedRows, nowSeconds),
            currentStateCandidateProfile: profileOrderRows(rows, nowSeconds),
        });

        let updated = 0;
        let validatedOrders = 0;
        let lastProgressLogAt = startedAt;
        const validationSummary = createValidationSummary();
        for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index]!;
            const validation = await this.revalidateSeaportOrderWithReporting(
                row,
                logContext,
                index + 1,
                rows.length,
                startedAt,
            );
            const result = this.applyValidation(row, validation.status);
            validatedOrders += 1;
            updated += result.changes;
            recordValidation(validationSummary, row, validation);

            const now = Date.now();
            if (
                now - lastProgressLogAt >=
                ORDER_UPDATE_BY_MAKER_REPORTING_LIMIT.ProgressLogIntervalMs
            ) {
                lastProgressLogAt = now;
                logger.info(ORDER_UPDATE_BY_MAKER_LOG_MESSAGE.Progress, {
                    ...logContext,
                    durationMs: now - startedAt,
                    candidateOrders,
                    currentStateCandidateOrders,
                    skippedBeforeAnchorOrders,
                    validatedOrders,
                    remainingOrders: rows.length - validatedOrders,
                    updated,
                    lastOrderId: row.id,
                    validation: validationSummary,
                });
            }
        }

        logger.info(ORDER_UPDATE_BY_MAKER_LOG_MESSAGE.Completed, {
            ...logContext,
            durationMs: Date.now() - startedAt,
            candidateOrders,
            currentStateCandidateOrders,
            skippedBeforeAnchorOrders,
            validatedOrders,
            updated,
            validation: validationSummary,
        });
        return nextId;
    }

    private applyValidation(
        row: OrderRow,
        status: OrderStatus,
    ): { changes: number } {
        const now = this.nowSeconds();
        return db.writeTransaction(() => {
            const result = db
                .prepare<{
                    chainId: number;
                    orderId: string;
                    revision: number;
                    status: OrderStatus;
                    now: number;
                    stale: number;
                    active: string;
                }>(
                    "UPDATE orders SET validated_at=@now, updated_at=CASE WHEN fillability_status IS NOT @status THEN CURRENT_TIMESTAMP ELSE updated_at END, " +
                        "state_revision=state_revision+CASE WHEN fillability_status IS NOT @status THEN 1 ELSE 0 END,fillability_status=@status " +
                        "WHERE chain_id=@chainId AND id=@orderId AND state_revision=@revision AND source_status=@active " +
                        "AND (fillability_status IS NOT @status OR validated_at<=@stale)",
                )
                .run({
                    chainId: row.chain_id,
                    orderId: row.id,
                    revision: row.state_revision,
                    status,
                    now,
                    stale: now - STORAGE_POLICY.orderRevalidationSeconds,
                    active: ORDER_SOURCE_STATUS.Active,
                });
            if (result.changes)
                this.listingPrices.refreshOrder(row.chain_id, row.id, now);
            return result;
        })();
    }

    async handleOrderUpdateById(
        payload: OrderUpdateByIdPayload,
    ): Promise<void> {
        if (payload.sourceStatus) {
            const result = db.writeTransaction(() => {
                const applied = this.applySourceObservation(payload);
                if (applied.changes)
                    this.listingPrices.refreshOrder(
                        payload.chainId,
                        payload.orderId,
                        this.nowSeconds(),
                    );
                return applied;
            })();

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

        let row: OrderRow | undefined;
        if (payload.blockNumber !== null && payload.blockNumber !== undefined) {
            row = this.selectOrderById.get({
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
            if (
                !this.canMutateCurrentStateForCollection(
                    row.chain_id,
                    row.collection_id,
                    payload.blockNumber,
                )
            ) {
                logger.debug(
                    "Orders update-by-id skipped before bootstrap anchor",
                    {
                        component: "OrdersDomain",
                        action: "handleOrderUpdateById",
                        chainId: row.chain_id,
                        collectionId: row.collection_id,
                        orderId: row.id,
                        reason: payload.reason,
                        blockNumber: payload.blockNumber ?? null,
                    },
                );
                return;
            }
        }

        let finalStatus: OrderStatus = status;
        if (payload.reason === "order") {
            const orderRow =
                row ??
                (this.selectOrderById.get({
                    chainId: payload.chainId,
                    orderId: payload.orderId,
                }) as OrderRow | undefined);
            if (!orderRow) {
                logger.warn("Orders update-by-id missing order", {
                    component: "OrdersDomain",
                    action: "handleOrderUpdateById",
                    ...payload,
                });
                return;
            }
            const order = mapOrderRow(orderRow);
            if (
                orderRow.valid_until !== null &&
                orderRow.valid_until <= this.nowSeconds()
            ) {
                this.applyValidation(orderRow, ORDER_STATUS.Expired);
                return;
            }
            if (orderRow.kind === "seaport" && hasSeaportData(order)) {
                const validation = await this.validateOrder(order);
                finalStatus = validation.status;
                logger.debug("Orders validation result", {
                    component: "OrdersDomain",
                    action: "handleOrderUpdateById",
                    orderId: orderRow.id,
                    chainId: orderRow.chain_id,
                    status: validation.status,
                    reason: validation.reason,
                });
            } else if (orderRow.kind === "seaport") {
                finalStatus = ORDER_STATUS.Invalid;
                logger.warn(
                    "Orders update-by-id missing canonical seaport data",
                    {
                        component: "OrdersDomain",
                        action: "handleOrderUpdateById",
                        chainId: orderRow.chain_id,
                        orderId: orderRow.id,
                    },
                );
            }
            this.applyValidation(orderRow, finalStatus);
            return;
        }

        const result = db.writeTransaction(() => {
            const applied = this.updateOrderFillabilityStatus.run({
                fillabilityStatus: finalStatus,
                chainId: payload.chainId,
                orderId: payload.orderId,
            });
            if (applied.changes && payload.blockNumber != null)
                db.prepare<[number, number, string]>(
                    "UPDATE orders SET block_number=? WHERE chain_id=? AND id=?",
                ).run(payload.blockNumber, payload.chainId, payload.orderId);
            if (applied.changes)
                this.listingPrices.refreshOrder(
                    payload.chainId,
                    payload.orderId,
                    this.nowSeconds(),
                );
            return applied;
        })();

        logger.debug("Orders update-by-id applied", {
            component: "OrdersDomain",
            action: "handleOrderUpdateById",
            ...payload,
            status: finalStatus,
            updated: result.changes,
        });
    }

    private applySourceObservation(payload: OrderUpdateByIdPayload): {
        changes: number;
    } {
        const now = this.nowSeconds();
        const at = payload.observedAt ?? now;
        // A late cancellation of a known order is still definitive. Do not
        // apply the create/replay age cutoff before looking up that order.
        if (
            !payload.sourceStatus ||
            !Number.isSafeInteger(at) ||
            at <= 0 ||
            at > now + STORAGE_POLICY.futureEventToleranceSeconds
        )
            return { changes: 0 };
        const row = this.selectOrderById.get({
            chainId: payload.chainId,
            orderId: payload.orderId,
        }) as OrderRow | undefined;
        const collectionId = row?.collection_id ?? payload.collectionId;
        if (
            collectionId == null ||
            !db
                .prepare<
                    [number, number]
                >("SELECT 1 FROM collections WHERE chain_id=? AND collection_id=?")
                .get(payload.chainId, collectionId)
        )
            return { changes: 0 };
        const terminal = isTerminalSourceStatus(payload.sourceStatus);
        if (
            row &&
            (isTerminalSourceStatus(row.source_status) ||
                row.fillability_status === ORDER_STATUS.Filled ||
                row.fillability_status === ORDER_STATUS.Cancelled)
        )
            return { changes: 0 };
        // A source cancellation is definitive even if a stale REST snapshot was
        // received afterward. Reversible inactivity obeys observation ordering.
        if (row && !terminal && at < row.observed_at) return { changes: 0 };
        if (
            !row &&
            (terminal || payload.sourceStatus === ORDER_SOURCE_STATUS.Inactive)
        ) {
            return db
                .prepare<
                    [number, number, string, number, number, string]
                >("INSERT INTO market_order_retirements(chain_id,collection_id,order_id,expires_at,retired_at,reason) VALUES (?,?,?,?,?,?) " + "ON CONFLICT(chain_id,order_id) DO UPDATE SET expires_at=MAX(expires_at,excluded.expires_at),retired_at=MAX(retired_at,excluded.retired_at),reason=excluded.reason " + `WHERE market_order_retirements.reason NOT IN ('${ORDER_RETIREMENT_REASON.Terminal}','${ORDER_RETIREMENT_REASON.SourceCancelled}') AND (excluded.reason IN ('${ORDER_RETIREMENT_REASON.Terminal}','${ORDER_RETIREMENT_REASON.SourceCancelled}') OR excluded.retired_at>market_order_retirements.retired_at)`)
                .run(
                    payload.chainId,
                    collectionId,
                    payload.orderId,
                    now + STORAGE_POLICY.unknownOrderLifetimeSeconds,
                    at,
                    payload.sourceStatus === ORDER_SOURCE_STATUS.Cancelled
                        ? ORDER_RETIREMENT_REASON.SourceCancelled
                        : terminal
                          ? ORDER_RETIREMENT_REASON.Terminal
                          : ORDER_RETIREMENT_REASON.Stale,
                );
        }
        if (!row) return { changes: 0 };
        return db
            .prepare<{
                status: string;
                at: number;
                chainId: number;
                orderId: string;
            }>(
                "UPDATE orders SET observed_at=MAX(observed_at,@at),state_revision=state_revision+CASE WHEN source_status IS NOT @status THEN 1 ELSE 0 END," +
                    "updated_at=CASE WHEN source_status IS NOT @status THEN CURRENT_TIMESTAMP ELSE updated_at END,source_status=@status " +
                    "WHERE chain_id=@chainId AND id=@orderId AND (source_status IS NOT @status OR observed_at<@at)",
            )
            .run({
                status: payload.sourceStatus,
                at,
                chainId: payload.chainId,
                orderId: payload.orderId,
            });
    }

    async handleOrderUpsert(payload: OrderUpsertPayload): Promise<{
        changed: boolean;
        validationNeeded: boolean;
        validationRevision: number;
    }> {
        // Admission, tombstone checks and mutation share the writer snapshot.
        // There is no network work inside this transaction.
        return db.writeTransaction(() => this.applyOrderUpsert(payload))();
    }

    private applyOrderUpsert(payload: OrderUpsertPayload): {
        changed: boolean;
        validationNeeded: boolean;
        validationRevision: number;
    } {
        const ignored = {
            changed: false,
            validationNeeded: false,
            validationRevision: 0,
        };
        const now = this.nowSeconds();
        const observedAt = payload.observedAt ?? now;
        if (!admitsOrderObservation(payload.validUntil, observedAt, now))
            return ignored;
        if (
            db
                .prepare<
                    [number, number]
                >("SELECT 1 FROM collections WHERE chain_id=? AND collection_id=?")
                .get(payload.chainId, payload.collectionId) === undefined
        )
            return ignored;
        const retired = db
            .prepare<
                [number, string, number]
            >("SELECT reason,retired_at,expires_at FROM market_order_retirements WHERE chain_id=? AND order_id=? AND expires_at>?")
            .get(payload.chainId, payload.orderId, now) as
            | { reason: string; retired_at: number; expires_at: number }
            | undefined;
        if (
            retired &&
            (isTerminalRetirement(retired.reason) ||
                observedAt <= retired.retired_at)
        ) {
            // A create that arrives after a cancel supplies the previously unknown
            // validity deadline. Keep only the small negative marker until then.
            if (
                isTerminalRetirement(retired.reason) &&
                payload.validUntil &&
                payload.validUntil + STORAGE_POLICY.orderReorgGraceSeconds >
                    retired.expires_at
            ) {
                db.prepare<[number, number, string]>(
                    "UPDATE market_order_retirements SET expires_at=? WHERE chain_id=? AND order_id=?",
                ).run(
                    payload.validUntil + STORAGE_POLICY.orderReorgGraceSeconds,
                    payload.chainId,
                    payload.orderId,
                );
            }
            return ignored;
        }
        const maker = payload.maker.toLowerCase();
        const taker = payload.taker?.toLowerCase() ?? null;
        const contract = payload.contract.toLowerCase();
        const currency = payload.currency?.toLowerCase() ?? null;
        const sourceScopeKind =
            payload.sourceScopeKind ?? ORDER_SOURCE_SCOPE_KIND.Token;
        const rawSourceKind = payload.rawSourceKind ?? "stream";
        const existingRow = this.selectOrderById.get({
            chainId: payload.chainId,
            orderId: payload.orderId,
        }) as OrderRow | undefined;
        if (
            existingRow &&
            (observedAt < existingRow.observed_at ||
                existingRow.fillability_status === ORDER_STATUS.Filled ||
                existingRow.fillability_status === ORDER_STATUS.Cancelled ||
                existingRow.source_status === ORDER_SOURCE_STATUS.Filled ||
                existingRow.source_status === ORDER_SOURCE_STATUS.Cancelled)
        )
            return ignored;
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
        const rawPayload =
            this.debugPayloads.persistRawDebugPayloads && payload.rawPayload
                ? JSON.stringify(payload.rawPayload)
                : null;
        const rawStreamData = rawSourceKind === "stream" ? rawPayload : null;
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
            collectionId: payload.collectionId,
            kind: payload.kind,
            side: payload.side,
            source: payload.source,
            maker,
            taker,
            contract,
            tokenId: payload.tokenId ?? null,
            sourceScopeKind,
            sourceCriteriaRoot: payload.sourceCriteriaRoot ?? null,
            sourceEncodedTokenIds: payload.sourceEncodedTokenIds ?? null,
            sourceSchemaJson,
            localTokenSetStatus:
                payload.localTokenSetStatus ??
                defaultLocalTokenSetStatus(sourceScopeKind),
            tokenSetId: payload.tokenSetId ?? null,
            tokenSetSchemaHash: payload.tokenSetSchemaHash ?? null,
            quantity: payload.quantity ?? "1",
            price: payload.price ?? null,
            currency,
            validFrom: payload.validFrom ?? null,
            validUntil: payload.validUntil ?? null,
            fillabilityStatus: ORDER_STATUS.Fillable,
            sourceStatus: payload.sourceStatus ?? ORDER_SOURCE_STATUS.Active,
            seaportDataJson,
            seaportDataSourceKind,
            rawRestData,
            rawStreamData,
            observedAt,
            protocolAddress:
                mergedSeaportData?.protocolAddress?.toLowerCase() ?? null,
            expectedRevision: existingRow?.state_revision ?? 0,
        });
        if (
            !result.changes &&
            existingRow &&
            observedAt - existingRow.observed_at >=
                STORAGE_POLICY.orderRevalidationSeconds
        ) {
            // Freshness is useful, but not worth rewriting the payload per event.
            db.prepare<[number, number, string]>(
                "UPDATE orders SET observed_at=? WHERE chain_id=? AND id=?",
            ).run(observedAt, payload.chainId, payload.orderId);
        }
        if (retired)
            db.prepare<[number, string]>(
                "DELETE FROM market_order_retirements WHERE chain_id=? AND order_id=?",
            ).run(payload.chainId, payload.orderId);
        this.listingPrices.refreshOrder(payload.chainId, payload.orderId, now);

        logger.debug("Orders upsert applied", {
            component: "OrdersDomain",
            action: "handleOrderUpsert",
            orderId: payload.orderId,
            chainId: payload.chainId,
            kind: payload.kind,
            side: payload.side,
            updated: result.changes,
        });
        return {
            changed: result.changes > 0,
            validationNeeded:
                result.changes > 0 ||
                (!!existingRow &&
                    existingRow.validated_at <=
                        now - STORAGE_POLICY.orderRevalidationSeconds),
            validationRevision: existingRow
                ? existingRow.state_revision + (result.changes > 0 ? 1 : 0)
                : 0,
        };
    }

    private selectMakerUpdateCandidates(
        payload: OrderUpdateByMakerPayload,
        afterId = "",
    ): OrderRow[] {
        const maker = payload.maker.toLowerCase();
        if (payload.scope === MAKER_TRIGGER_SCOPE.Token) {
            return this.selectMakerSellOrdersForToken.all({
                chainId: payload.chainId,
                collectionId: payload.collectionId,
                maker,
                tokenId: payload.tokenId,
                ...activeRevalidatableOrderParams(),
                nowSeconds: this.nowSeconds(),
                afterId,
                batchLimit: STORAGE_POLICY.maintenanceBatchRows,
            }) as OrderRow[];
        }
        if (payload.scope === MAKER_TRIGGER_SCOPE.Collection) {
            return this.selectMakerSellOrdersForCollection.all({
                chainId: payload.chainId,
                collectionId: payload.collectionId,
                maker,
                ...activeRevalidatableOrderParams(),
                nowSeconds: this.nowSeconds(),
                afterId,
                batchLimit: STORAGE_POLICY.maintenanceBatchRows,
            }) as OrderRow[];
        }

        switch (payload.reason) {
            case GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance:
            case GLOBAL_MAKER_TRIGGER_REASON.ApprovalChange:
                return this.selectMakerWethBuyOrders.all({
                    chainId: payload.chainId,
                    maker,
                    currency: this.wethAddress,
                    ...activeRevalidatableOrderParams(),
                    nowSeconds: this.nowSeconds(),
                    afterId,
                    batchLimit: STORAGE_POLICY.maintenanceBatchRows,
                }) as OrderRow[];
            case GLOBAL_MAKER_TRIGGER_REASON.OrderCounter:
                return this.selectMakerSeaportOrders.all({
                    chainId: payload.chainId,
                    maker,
                    ...activeRevalidatableOrderParams(),
                    nowSeconds: this.nowSeconds(),
                    afterId,
                    batchLimit: STORAGE_POLICY.maintenanceBatchRows,
                }) as OrderRow[];
        }
    }

    private filterCurrentStateRows(
        chainId: number,
        rows: OrderRow[],
        blockNumber: number | null | undefined,
    ): OrderRow[] {
        const anchorByCollectionId = new Map<number, number | null>();
        return rows.filter((row) =>
            this.canMutateCurrentStateForCollection(
                chainId,
                row.collection_id,
                blockNumber,
                anchorByCollectionId,
            ),
        );
    }

    private canMutateCurrentStateForCollection(
        chainId: number,
        collectionId: number,
        blockNumber: number | null | undefined,
        anchorByCollectionId?: Map<number, number | null>,
    ): boolean {
        if (blockNumber === null || blockNumber === undefined) {
            return true;
        }

        const cachedAnchor = anchorByCollectionId?.get(collectionId);
        if (cachedAnchor !== undefined) {
            return CollectionRecord.canProjectCurrentStateAtBlock(
                cachedAnchor,
                blockNumber,
            );
        }

        const row = this.selectCollectionAnchor.get(chainId, collectionId) as
            | CollectionAnchorRow
            | undefined;
        const anchorBlock = row?.bootstrap_anchor_block ?? null;
        anchorByCollectionId?.set(collectionId, anchorBlock);
        return CollectionRecord.canProjectCurrentStateAtBlock(
            anchorBlock,
            blockNumber,
        );
    }

    private async revalidateSeaportOrder(
        row: OrderRow,
    ): Promise<{ status: OrderStatus; reason: string }> {
        return this.validateOrder(mapOrderRow(row));
    }

    private async revalidateSeaportOrderWithReporting(
        row: OrderRow,
        context: OrderUpdateByMakerLogContext,
        orderPosition: number,
        orderCount: number,
        jobStartedAt: number,
    ): Promise<TimedOrderValidation> {
        const startedAt = Date.now();
        const slowTimer = setInterval(() => {
            logger.warn(
                ORDER_UPDATE_BY_MAKER_LOG_MESSAGE.ValidationStillRunning,
                {
                    ...context,
                    orderId: row.id,
                    orderPosition,
                    orderCount,
                    orderElapsedMs: Date.now() - startedAt,
                    jobElapsedMs: Date.now() - jobStartedAt,
                    collectionId: row.collection_id,
                    side: row.side,
                    sourceStatus: row.source_status,
                    fillabilityStatus: row.fillability_status,
                },
            );
        }, ORDER_UPDATE_BY_MAKER_REPORTING_LIMIT.SlowValidationLogIntervalMs);
        unrefTimer(slowTimer);

        try {
            const validation = await this.revalidateSeaportOrder(row);
            return {
                ...validation,
                durationMs: Date.now() - startedAt,
            };
        } finally {
            clearInterval(slowTimer);
        }
    }
}

function mapOrderRow(row: OrderRow): OrderRecord {
    return {
        id: row.id,
        chainId: row.chain_id,
        collectionId: row.collection_id,
        kind: row.kind,
        side: row.side,
        source: row.source,
        maker: row.maker,
        taker: row.taker,
        contract: row.contract,
        tokenId: row.token_id,
        sourceScopeKind: row.source_scope_kind as OrderSourceScopeKind,
        sourceCriteriaRoot: row.source_criteria_root,
        sourceEncodedTokenIds: row.source_encoded_token_ids,
        sourceSchemaJson: row.source_schema_json,
        localTokenSetStatus:
            row.local_token_set_status as OrderLocalTokenSetStatus,
        tokenSetId: row.token_set_id,
        tokenSetSchemaHash: row.token_set_schema_hash,
        quantity: row.quantity,
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

function activeRevalidatableOrderParams(): Omit<
    ActiveRevalidatableOrderParams,
    "nowSeconds" | "afterId" | "batchLimit"
> {
    return {
        sourceStatus: ORDER_SOURCE_STATUS.Active,
        fillableStatus: ORDER_REVALIDATABLE_FILLABILITY_STATUS.Fillable,
        noBalanceStatus: ORDER_REVALIDATABLE_FILLABILITY_STATUS.NoBalance,
        noApprovalStatus: ORDER_REVALIDATABLE_FILLABILITY_STATUS.NoApproval,
    };
}

function buildOrderUpdateByMakerLogContext(
    payload: OrderUpdateByMakerPayload,
    context?: OrderUpdateByMakerRuntimeContext,
): OrderUpdateByMakerLogContext {
    return {
        component: ORDER_UPDATE_BY_MAKER_LOG_CONTEXT.Component,
        action: ORDER_UPDATE_BY_MAKER_LOG_CONTEXT.Action,
        chainId: payload.chainId,
        scope: payload.scope,
        maker: payload.maker.toLowerCase(),
        reason: payload.reason,
        blockNumber: payload.blockNumber ?? null,
        blockHash: payload.blockHash ?? null,
        txHash: payload.txHash ?? null,
        logIndex: payload.logIndex ?? null,
        collectionId:
            payload.scope !== MAKER_TRIGGER_SCOPE.Global
                ? payload.collectionId
                : null,
        tokenId:
            payload.scope === MAKER_TRIGGER_SCOPE.Token
                ? payload.tokenId
                : null,
        jobId: context?.jobId ?? null,
        attempt: context?.attempt ?? null,
        scheduledAt: context?.scheduledAt ?? null,
        traceId: context?.traceId ?? null,
        consumerName: context?.consumerName ?? null,
    };
}

function profileOrderRows(
    rows: OrderRow[],
    nowSeconds: number,
): OrderRowsProfile {
    const profile: OrderRowsProfile = {
        count: rows.length,
        sourceStatuses: {},
        fillabilityStatuses: {},
        sides: {},
        collections: {},
        validity: {},
    };
    for (const row of rows) {
        incrementCount(profile.sourceStatuses, row.source_status);
        incrementCount(profile.fillabilityStatuses, row.fillability_status);
        incrementCount(
            profile.sides,
            row.side ?? ORDER_UPDATE_BY_MAKER_REPORTING_BUCKET.Unknown,
        );
        incrementCount(profile.collections, String(row.collection_id));
        incrementCount(
            profile.validity,
            resolveOrderValidityState(
                {
                    validFrom: row.valid_from,
                    validUntil: row.valid_until,
                },
                nowSeconds,
            ),
        );
    }
    return profile;
}

function createValidationSummary(): ValidationSummary {
    return { statuses: {}, reasons: {}, slowest: [] };
}

function recordValidation(
    summary: ValidationSummary,
    row: OrderRow,
    validation: TimedOrderValidation,
): void {
    incrementCount(summary.statuses, validation.status);
    incrementCount(summary.reasons, validation.reason);
    summary.slowest.push({
        orderId: row.id,
        collectionId: row.collection_id,
        side: row.side,
        sourceStatus: row.source_status,
        fillabilityStatus: row.fillability_status,
        durationMs: validation.durationMs,
        status: validation.status,
        reason: validation.reason,
    });
    summary.slowest.sort((left, right) => right.durationMs - left.durationMs);
    if (
        summary.slowest.length >
        ORDER_UPDATE_BY_MAKER_REPORTING_LIMIT.SlowSampleLimit
    ) {
        summary.slowest.length =
            ORDER_UPDATE_BY_MAKER_REPORTING_LIMIT.SlowSampleLimit;
    }
}

function incrementCount<Key extends string>(
    counts: Partial<Record<Key, number>>,
    key: Key,
): void {
    counts[key] = (counts[key] ?? 0) + 1;
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
    if (typeof timer !== "object" || timer === null || !("unref" in timer)) {
        return;
    }
    const maybeTimer = timer as { unref?: () => void };
    maybeTimer.unref?.();
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

function defaultLocalTokenSetStatus(
    sourceScopeKind: OrderSourceScopeKind,
): OrderLocalTokenSetStatus {
    if (sourceScopeKind === ORDER_SOURCE_SCOPE_KIND.Token) {
        return ORDER_LOCAL_TOKEN_SET_STATUS.None;
    }

    return ORDER_LOCAL_TOKEN_SET_STATUS.Unresolved;
}
