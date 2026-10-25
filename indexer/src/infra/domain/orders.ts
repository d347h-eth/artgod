import {
    ChainSyncConflict,
    type ChainSyncCheckpoint,
    type SyncBlockHeader,
} from "../../domain/chain-sync.js";
import type { CanonicalOrderUpdate } from "../../domain/canonical-order-effects.js";
import type { CanonicalOrderProjectionPort } from "../../ports/canonical-order-effects.js";
import { assertChainSyncCheckpoint } from "../storage/sqlite-chain-revisions.js";
import { SqliteOrderObservations } from "../orders/sqlite-order-observations.js";
import {
    ORDER_OBSERVATION_KIND,
    orderObservationKey,
    orderDeclarationReady,
    orderDeclarationValidity,
    mergeOrderDeclaration,
    assertOrderDeclarationIdentity,
} from "../../domain/order-observation.js";
import type { OrderValidationEvidence } from "../../domain/order-validation-demand.js";
import {
    declaredOrderQuantity,
    declaredOrderQuote,
    validatedQuantityUpdate,
} from "../../domain/order-quantity.js";
import {
    eventValidationRequest,
    observedOrderValidationRequest,
} from "../../domain/order-validation-demand.js";
import type { OrderValidationResult } from "../../domain/orders.js";
import type { OrderMutationObserver } from "../../application/orders/observability.js";
import { observeBestEffort } from "../../application/processing-observability.js";
import { db } from "@artgod/shared/database";
import { zeroAddress } from "viem";
import { SqliteDailyListingPrices } from "../storage/sqlite-daily-listing-prices.js";
import { SqliteOrderRetirements } from "../storage/sqlite-order-retirements.js";
import { MARKET_DATA_STORAGE_POLICY as STORAGE_POLICY } from "@artgod/shared/market-data/storage-policy";
import {
    admitsOrderObservation,
    isTerminalRetirement,
    ORDER_RETIREMENT_REASON,
    knownOrderExpiry,
} from "../../domain/order-retention.js";
import {
    getDefaultDebugPayloadPersistenceConfig,
    type DebugPayloadPersistenceConfig,
} from "@artgod/shared/config/debug-payload-persistence";
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
    ORDER_SIDE,
} from "../../domain/orders.js";
import type {
    OrderUpdateByIdPayload,
    OrderUpdateByMakerPayload,
    OrderUpsertPayload,
} from "../../domain/order-jobs.js";
import { ORDER_UPDATE_REASON } from "../../domain/order-jobs.js";
import type {
    OrdersDomainPort,
    OrderSourceReconciliationPort,
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
import type { OrderValidator } from "../../ports/order-validation.js";
import {
    type MakerPassBoundary,
    type MakerValidationCandidate,
} from "../../domain/maker-revalidation.js";
import type { MakerOrderProjectionPort } from "../../ports/maker-revalidation.js";
import type { OrderValidationProjectionPort } from "../../ports/order-validation-demand.js";
import {
    needsCurrentOrderValidation,
    type OrderValidationRequest,
    type ClaimedOrderValidation,
} from "../../domain/order-validation-demand.js";
import { SqliteOrderValidationDemand } from "../orders/sqlite-order-validation-demand.js";

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
    original_quantity: string | null;
    fillable_quantity: string | null;
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
    upperOrderId: string;
    upperRowId: number;
    sourceStatus: OrderSourceStatus;
    fillableStatus: OrderStatus;
    noBalanceStatus: OrderStatus;
    noApprovalStatus: OrderStatus;
    unvalidatedStatus: OrderStatus;
};

const SELECT_ORDER_FIELDS =
    "SELECT id, chain_id, collection_id, kind, side, source, maker, taker, contract_address AS contract, token_id, source_scope_kind, source_criteria_root, source_encoded_token_ids, source_schema_json, local_token_set_status, token_set_id, token_set_schema_hash, quantity, original_quantity, fillable_quantity, price, currency, " +
    "valid_from, valid_until, fillability_status, source_status, seaport_data_json, seaport_data_source_kind, block_number, tx_hash, log_index, observed_at, validated_at, state_revision " +
    "FROM orders ";

const ACTIVE_REVALIDATABLE_ORDER_FILTER =
    "AND source_status = @sourceStatus " +
    "AND (valid_until IS NULL OR valid_until > @nowSeconds) AND id > @afterId " +
    "AND id <= @upperOrderId AND rowid <= @upperRowId " +
    "AND fillability_status IN (@fillableStatus, @noBalanceStatus, @noApprovalStatus, @unvalidatedStatus) ";

export class SqliteOrdersDomain
    implements
        OrdersDomainPort,
        MakerOrderProjectionPort,
        OrderValidationProjectionPort,
        CanonicalOrderProjectionPort,
        OrderSourceReconciliationPort
{
    private readonly listingPrices: SqliteDailyListingPrices;
    private readonly retirements: SqliteOrderRetirements;
    private readonly wethAddress: string;
    private readonly validationDemand = new SqliteOrderValidationDemand(this);
    private readonly observations = new SqliteOrderObservations();
    private updateOrderFillabilityStatus =
        db.prepare<OrderFillabilityStatusParams>(
            "UPDATE orders SET fillability_status = @fillabilityStatus, state_revision = state_revision + 1, updated_at = CURRENT_TIMESTAMP " +
                "WHERE chain_id = @chainId AND id = @orderId AND fillability_status IS NOT @fillabilityStatus",
        );
    private selectOrderById = db.prepare<OrderIdentityParams>(
        "SELECT id, chain_id, collection_id, kind, side, source, maker, taker, contract_address AS contract, token_id, source_scope_kind, source_criteria_root, source_encoded_token_ids, source_schema_json, local_token_set_status, token_set_id, token_set_schema_hash, quantity, original_quantity, fillable_quantity, price, currency, " +
            "valid_from, valid_until, fillability_status, source_status, seaport_data_json, seaport_data_source_kind, block_number, tx_hash, log_index, observed_at, validated_at, state_revision " +
            "FROM orders WHERE chain_id = @chainId AND id = @orderId",
    );
    private selectMakerSellOrdersForToken =
        db.prepare<MakerSellOrdersForTokenParams>(
            SELECT_ORDER_FIELDS +
                "WHERE chain_id = @chainId AND kind = 'seaport' AND maker = @maker AND side = 'sell' " +
                "AND collection_id = @collectionId AND token_id = @tokenId " +
                ACTIVE_REVALIDATABLE_ORDER_FILTER +
                "ORDER BY id LIMIT @batchLimit",
        );
    private selectMakerSellOrdersForCollection =
        db.prepare<MakerSellOrdersForCollectionParams>(
            SELECT_ORDER_FIELDS +
                "WHERE chain_id = @chainId AND kind = 'seaport' AND maker = @maker AND side = 'sell' " +
                "AND collection_id = @collectionId " +
                ACTIVE_REVALIDATABLE_ORDER_FILTER +
                "ORDER BY id LIMIT @batchLimit",
        );
    private selectMakerWethBuyOrders = db.prepare<MakerWethBuyOrdersParams>(
        SELECT_ORDER_FIELDS +
            "WHERE chain_id = @chainId AND kind = 'seaport' AND maker = @maker AND side = 'buy' " +
            "AND currency = @currency " +
            ACTIVE_REVALIDATABLE_ORDER_FILTER +
            "ORDER BY id LIMIT @batchLimit",
    );
    private selectMakerSeaportOrders = db.prepare<MakerSeaportOrdersParams>(
        SELECT_ORDER_FIELDS +
            "WHERE chain_id = @chainId AND kind = 'seaport' AND maker = @maker " +
            ACTIVE_REVALIDATABLE_ORDER_FILTER +
            "ORDER BY id LIMIT @batchLimit",
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
        quantity: string | null;
        originalQuantity: string | null;
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
        "INSERT INTO orders (id, chain_id, collection_id, kind, side, source, maker, taker, contract_address, token_id, source_scope_kind, source_criteria_root, source_encoded_token_ids, source_schema_json, local_token_set_status, token_set_id, token_set_schema_hash, quantity, original_quantity, price, currency, valid_from, valid_until, fillability_status, source_status, seaport_data_json, seaport_data_source_kind, raw_rest_data, raw_stream_data, observed_at, protocol_address) " +
            "VALUES (@id, @chainId, @collectionId, @kind, @side, @source, @maker, @taker, @contract, @tokenId, @sourceScopeKind, @sourceCriteriaRoot, @sourceEncodedTokenIds, @sourceSchemaJson, @localTokenSetStatus, @tokenSetId, @tokenSetSchemaHash, @quantity, @originalQuantity, @price, @currency, @validFrom, @validUntil, @fillabilityStatus, @sourceStatus, @seaportDataJson, @seaportDataSourceKind, @rawRestData, @rawStreamData, @observedAt, @protocolAddress) " +
            "ON CONFLICT(id) DO UPDATE SET " +
            "collection_id = excluded.collection_id, " +
            "kind = excluded.kind, " +
            "side = excluded.side, " +
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
            // Source quantities remain observations; only chain proof owns remainder.
            "quantity=orders.quantity, " +
            "original_quantity=COALESCE(excluded.original_quantity,orders.original_quantity), " +
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
            // A validation stamp belongs to the canonical revision it checked.
            // Invalidating it with the revision keeps a failed publish retryable.
            "state_revision = state_revision + 1, validated_at = 0, updated_at = CURRENT_TIMESTAMP " +
            "WHERE orders.chain_id=excluded.chain_id AND orders.state_revision=@expectedRevision AND " +
            "(kind,side,maker,taker,contract_address,token_id,source_scope_kind,source_criteria_root,source_encoded_token_ids,source_schema_json,local_token_set_status,token_set_id,token_set_schema_hash,quantity,original_quantity,price,currency,valid_from,valid_until,source_status,seaport_data_json,seaport_data_source_kind) IS NOT " +
            "(excluded.kind,excluded.side,excluded.maker,excluded.taker,excluded.contract_address,excluded.token_id,excluded.source_scope_kind,excluded.source_criteria_root,excluded.source_encoded_token_ids,excluded.source_schema_json,excluded.local_token_set_status,excluded.token_set_id,excluded.token_set_schema_hash,orders.quantity,COALESCE(excluded.original_quantity,orders.original_quantity),excluded.price,excluded.currency,excluded.valid_from,excluded.valid_until,excluded.source_status,COALESCE(excluded.seaport_data_json,orders.seaport_data_json),COALESCE(excluded.seaport_data_source_kind,orders.seaport_data_source_kind))",
    );

    constructor(
        wethAddress: string,
        private debugPayloads: DebugPayloadPersistenceConfig = getDefaultDebugPayloadPersistenceConfig(),
        private readonly nowSeconds = () => Math.floor(Date.now() / 1000),
        private readonly mutations?: OrderMutationObserver,
    ) {
        this.wethAddress = wethAddress.toLowerCase();
        this.retirements = new SqliteOrderRetirements(db.raw);
        this.listingPrices = new SqliteDailyListingPrices(db, [
            zeroAddress,
            this.wethAddress,
        ]);
    }

    private applyValidation(
        row: OrderRow,
        validation: OrderValidationResult | OrderStatus,
        block: SyncBlockHeader | null = null,
    ): { changes: number } {
        const result =
            typeof validation === "string"
                ? { status: validation }
                : validation;
        // Current result attribution belongs to the order, not to demand's reusable
        // coverage cache. Retirement uses it only when the result proves terminality.
        const quantities = validatedQuantityUpdate(result);
        const status = result.status;
        const now = this.nowSeconds();
        const changedResult =
            "(fillability_status,original_quantity,quantity,fillable_quantity) IS NOT (@status,COALESCE(@original,original_quantity),COALESCE(@remaining,quantity),@fillable)";
        // The earlier proof still establishes an unchanged result. Newer coverage
        // belongs to demand; a block advance alone must not rewrite the order.
        const replaceAttribution = `(${changedResult} OR (block_number IS NULL AND @blockNumber IS NOT NULL))`;
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
                    original: string | null;
                    remaining: string | null;
                    fillable: string | null;
                    blockNumber: number | null;
                    blockHash: string | null;
                }>(
                    `UPDATE orders SET validated_at=@now, updated_at=CASE WHEN ${changedResult} THEN CURRENT_TIMESTAMP ELSE updated_at END, ` +
                        `state_revision=state_revision+CASE WHEN ${changedResult} THEN 1 ELSE 0 END, fillability_status=@status, ` +
                        `original_quantity=COALESCE(@original,original_quantity), quantity=COALESCE(@remaining,quantity), fillable_quantity=@fillable, block_number=CASE WHEN ${changedResult} THEN @blockNumber ELSE COALESCE(block_number,@blockNumber) END, ` +
                        `block_hash=CASE WHEN ${replaceAttribution} THEN @blockHash ELSE block_hash END, tx_hash=CASE WHEN ${replaceAttribution} THEN NULL ELSE tx_hash END, log_index=CASE WHEN ${replaceAttribution} THEN NULL ELSE log_index END ` +
                        "WHERE chain_id=@chainId AND id=@orderId AND state_revision=@revision AND source_status=@active " +
                        `AND (${replaceAttribution} OR validated_at<=@stale)`,
                )
                .run({
                    chainId: row.chain_id,
                    orderId: row.id,
                    revision: row.state_revision,
                    status,
                    now,
                    stale: now - STORAGE_POLICY.orderRevalidationSeconds,
                    active: ORDER_SOURCE_STATUS.Active,
                    original: quantities.original,
                    remaining: quantities.remaining,
                    fillable: quantities.fillable,
                    blockNumber: block?.number ?? null,
                    blockHash: block?.hash ?? null,
                });
            return result;
        })();
    }

    /** Only the coordinator invokes definitive canonical effects, inside its writer. */
    applyCanonicalOrderUpdate(
        payload: CanonicalOrderUpdate,
        checkpoint: ChainSyncCheckpoint,
        now: number,
    ): void {
        if (!db.raw.inTransaction)
            throw new Error("Canonical order effects require the sync writer");
        assertChainSyncCheckpoint(checkpoint);
        if (
            payload.chainId !== checkpoint.chainId ||
            !db
                .prepare(
                    "SELECT 1 FROM blocks WHERE chain_id=? AND block_number=? AND block_hash=?",
                )
                .get(payload.chainId, payload.blockNumber, payload.blockHash)
        )
            throw new ChainSyncConflict(
                "Canonical order effect has no accepted header",
            );
        const row = this.selectOrderById.get({
            chainId: payload.chainId,
            orderId: payload.orderId,
        }) as OrderRow | undefined;
        if (
            !row ||
            !this.canMutateCurrentStateForCollection(
                row.chain_id,
                row.collection_id,
                payload.blockNumber,
            )
        )
            return;
        if (payload.reason === ORDER_UPDATE_REASON.Cancel) {
            db.prepare(
                `UPDATE orders SET fillability_status=?,fillable_quantity='0',state_revision=state_revision+1,
                 block_number=?,block_hash=?,tx_hash=?,log_index=?,validated_at=?,updated_at=CURRENT_TIMESTAMP,
                 proof_block_number=?,proof_block_hash=?,proof_chain_revision=?,proof_order_revision=state_revision+1,proof_at=?
                 WHERE chain_id=? AND id=? AND fillability_status<>?`,
            ).run(
                ORDER_STATUS.Cancelled,
                payload.blockNumber,
                payload.blockHash,
                payload.txHash,
                payload.logIndex,
                Math.floor(now / 1_000),
                payload.blockNumber,
                payload.blockHash,
                checkpoint.revision,
                now,
                payload.chainId,
                payload.orderId,
                ORDER_STATUS.Cancelled,
            );
            this.listingPrices.refreshOrder(
                payload.chainId,
                payload.orderId,
                Math.floor(now / 1_000),
            );
        } else {
            // Every fill requests cumulative protocol state. This also handles
            // unknown/partial terms without deriving quantities from an event count.
            this.validationDemand.admit(
                eventValidationRequest(
                    payload.chainId,
                    payload.orderId,
                    payload.blockNumber,
                    payload.blockHash,
                ),
                now,
            );
        }
    }

    async handleOrderUpdateById(
        payload: OrderUpdateByIdPayload,
    ): Promise<void> {
        if (!payload.source)
            throw new Error("Order observation is missing its source");
        const observation = db.writeTransaction(() => {
            const observation = this.applySourceObservation(payload);
            if (observation?.listing)
                this.listingPrices.refreshOrder(
                    payload.chainId,
                    payload.orderId,
                    this.nowSeconds(),
                );
            return observation;
        })();
        if (observation)
            observeBestEffort(() =>
                this.mutations?.sourceUpdated(
                    observation.changed,
                    observation.availability,
                    payload.reason,
                ),
            );
    }

    withdrawMissingSources(
        input: Parameters<
            OrderSourceReconciliationPort["withdrawMissingSources"]
        >[0],
    ): number {
        return db.writeTransaction(() => {
            let count = 0;
            const sellers = new Map<
                string,
                { tokenId: string; maker: string }
            >();
            for (const orderId of input.orderIds) {
                if (
                    !this.observations.isUnobservedSource({
                        ...input,
                        sourceId: input.source,
                        orderId,
                    })
                )
                    continue;
                const observation = this.applySourceObservation({
                    chainId: input.chainId,
                    collectionId: input.collectionId,
                    orderId,
                    source: input.source,
                    sourceStatus: ORDER_SOURCE_STATUS.Inactive,
                    reason: ORDER_UPDATE_REASON.Validation,
                    observedAt: input.startedAt,
                });
                if (!observation) continue;
                count++;
                if (observation.listing)
                    sellers.set(
                        JSON.stringify(observation.listing),
                        observation.listing,
                    );
            }
            // Source facts, newly pending evidence and today's ask change
            // together. Refresh once per seller even when several orders vanish.
            const now = this.nowSeconds();
            for (const seller of sellers.values())
                this.listingPrices.refreshSeller(
                    {
                        chain_id: input.chainId,
                        collection_id: input.collectionId,
                        token_id: seller.tokenId,
                        maker: seller.maker,
                    },
                    now,
                );
            return count;
        })();
    }

    private applySourceObservation(payload: OrderUpdateByIdPayload):
        | {
              changed: boolean;
              availability: OrderSourceStatus;
              listing?: { tokenId: string; maker: string };
          }
        | undefined {
        const row = this.selectOrderById.get({
            chainId: payload.chainId,
            orderId: payload.orderId,
        }) as OrderRow | undefined;
        const collectionId = row?.collection_id ?? payload.collectionId;
        if (
            collectionId == null ||
            !payload.source ||
            !db
                .prepare(
                    "SELECT 1 FROM collections WHERE chain_id=? AND collection_id=?",
                )
                .get(payload.chainId, collectionId)
        )
            return;
        const now = this.nowSeconds() * 1_000;
        const key = orderObservationKey(
            payload.source,
            ORDER_OBSERVATION_KIND.Update,
            [
                payload.orderId,
                payload.reason,
                payload.sourceStatus ?? null,
                payload.executionTransactionHash ?? null,
                payload.observedAt ?? null,
            ],
        );
        const observation = this.observations.retain({
            chainId: payload.chainId,
            collectionId,
            orderId: payload.orderId,
            sourceId: payload.source,
            observationKey: key,
            status: payload.sourceStatus,
            declaration: false,
            sourceObservedAt: payload.observedAt,
            validUntil: row?.valid_until ?? payload.validUntil,
            now,
        });
        if (!row)
            return { changed: false, availability: observation.availability };
        const changed = this.observations.projectAvailability(
            payload.chainId,
            payload.orderId,
            observation.availability,
        );
        if (observation.changed)
            this.validationDemand.admit(
                observedOrderValidationRequest(
                    payload.chainId,
                    payload.orderId,
                    key,
                ),
                now,
            );
        const projectionAffected = Boolean(changed) || observation.changed;
        return {
            changed: Boolean(changed),
            availability: observation.availability,
            ...(projectionAffected &&
            row.side === ORDER_SIDE.Sell &&
            row.token_id !== null
                ? { listing: { tokenId: row.token_id, maker: row.maker } }
                : {}),
        };
    }

    async handleOrderUpsert(payload: OrderUpsertPayload): Promise<void> {
        // Admission, tombstone checks and mutation share the writer snapshot.
        // There is no network work inside this transaction.
        const outcome = db.writeTransaction(() => {
            const now = this.nowSeconds();
            const outcome = this.applyOrderUpsert(payload, now);
            if (outcome.validationNeeded && outcome.observationKey) {
                this.validationDemand.admit(
                    observedOrderValidationRequest(
                        payload.chainId,
                        payload.orderId,
                        outcome.observationKey,
                    ),
                    now * 1_000,
                );
            }
            // New validation demand can make a previously proven ask ineligible.
            // Refresh only after retaining it, so daily prices use the same asks
            // as current orderbook readers when this transaction commits.
            if (outcome.observationKey)
                this.listingPrices.refreshOrder(
                    payload.chainId,
                    payload.orderId,
                    now,
                );
            return outcome;
        })();
        observeBestEffort(() => this.mutations?.upserted(outcome.changed));
    }

    private applyOrderUpsert(
        payload: OrderUpsertPayload,
        now: number,
    ): {
        changed: boolean;
        validationNeeded: boolean;
        observationKey: string | null;
    } {
        const ignored = {
            changed: false,
            validationNeeded: false,
            observationKey: null,
        };
        const observedAt = now;
        const existingRow = this.selectOrderById.get({
            chainId: payload.chainId,
            orderId: payload.orderId,
        }) as OrderRow | undefined;
        const signedValidity = orderDeclarationValidity(
            payload.seaportData ??
                (existingRow ? mapOrderRow(existingRow).seaportData : null),
        );
        const validUntil =
            signedValidity?.validUntil ??
            payload.validUntil ??
            existingRow?.valid_until ??
            null;
        const validFrom =
            signedValidity?.validFrom ??
            payload.validFrom ??
            existingRow?.valid_from ??
            null;
        const admitted = admitsOrderObservation(validUntil, observedAt, now);
        // A rejected creation can still reveal immutable expiry for its marker.
        // This does not admit the order or restart its observation clock.
        if (!admitted && knownOrderExpiry(validUntil) === null) return ignored;
        const collection = db
            .prepare<
                [number, number]
            >("SELECT address FROM collections WHERE chain_id=? AND collection_id=?")
            .get(payload.chainId, payload.collectionId) as
            | { address: string }
            | undefined;
        if (!collection) return ignored;
        if (collection.address.toLowerCase() !== payload.contract.toLowerCase())
            throw new Error(
                "Order observation conflicts with collection contract",
            );
        const retired = this.retirements.find(payload.chainId, payload.orderId);
        if (
            retired &&
            retired.expiresAt > now &&
            (isTerminalRetirement(retired.reason) || !admitted)
        ) {
            // Learning the order's actual deadline replaces the fallback, even
            // when it is shorter. It never resurrects the rejected order.
            this.retirements.record(
                {
                    ...retired,
                    chainId: payload.chainId,
                    collectionId: payload.collectionId,
                    orderId: payload.orderId,
                    validUntil,
                },
                now,
            );
            return ignored;
        }
        // A stale marker is a cleanup record, not an ordering clock. Retained
        // source observations decide replay/withdrawal; a newly available source
        // can admit the same declaration even within the cleanup's second.
        if (!admitted) return ignored;
        if (
            existingRow &&
            (existingRow.collection_id !== payload.collectionId ||
                existingRow.kind !== payload.kind ||
                existingRow.side !== payload.side ||
                existingRow.maker !== payload.maker.toLowerCase() ||
                existingRow.contract !== payload.contract.toLowerCase() ||
                existingRow.source_scope_kind !== payload.sourceScopeKind ||
                existingRow.token_id !== (payload.tokenId ?? null))
        )
            throw new Error(
                "Order observation conflicts with retained declaration identity",
            );
        const foreign = db
            .prepare("SELECT chain_id FROM orders WHERE id=? AND chain_id<>?")
            .get(payload.orderId, payload.chainId);
        if (foreign)
            throw new Error(
                "Order hash is already retained in another chain context",
            );
        const maker = payload.maker.toLowerCase();
        const taker = payload.taker?.toLowerCase() ?? null;
        const contract = payload.contract.toLowerCase();
        const sourceScopeKind = payload.sourceScopeKind;
        const rawSourceKind = payload.rawSourceKind;
        const existingOrder = existingRow ? mapOrderRow(existingRow) : null;
        assertOrderDeclarationIdentity({
            id: payload.orderId,
            maker,
            side: payload.side,
            contract,
            tokenId: payload.tokenId ?? null,
            sourceScopeKind: payload.sourceScopeKind,
            seaportData: payload.seaportData,
        });
        const mergedSeaportData = mergeOrderDeclaration(
            existingOrder?.seaportData ?? null,
            payload.seaportData ?? null,
        );
        const quote = mergedSeaportData
            ? declaredOrderQuote({ ...payload, seaportData: mergedSeaportData })
            : {
                  price: payload.price ?? null,
                  currency: payload.currency?.toLowerCase() ?? null,
              };
        const seaportDataSourceKind = resolveSeaportDataSourceKind(
            existingOrder?.seaportDataSourceKind ?? null,
            payload.seaportData ?? null,
            rawSourceKind,
        );
        const rawPayload =
            this.debugPayloads.persistRawDebugPayloads && payload.rawPayload
                ? JSON.stringify(payload.rawPayload)
                : null;
        const rawStreamData =
            rawSourceKind === ORDER_SEAPORT_DATA_SOURCE_KIND.Stream
                ? rawPayload
                : null;
        const rawRestData =
            rawSourceKind === ORDER_SEAPORT_DATA_SOURCE_KIND.Rest
                ? rawPayload
                : null;
        const sourceSchemaJson = payload.sourceSchema
            ? JSON.stringify(payload.sourceSchema)
            : null;
        const seaportDataJson = mergedSeaportData
            ? JSON.stringify(mergedSeaportData)
            : null;
        const observationKey = orderObservationKey(
            payload.source,
            ORDER_OBSERVATION_KIND.Declaration,
            [
                payload.orderId,
                payload.sourceStatus ?? ORDER_SOURCE_STATUS.Active,
                payload.quantity ?? null,
                mergedSeaportData?.protocolAddress.toLowerCase() ?? null,
                mergedSeaportData?.signature ?? null,
            ],
        );
        const observation = this.observations.retain({
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            orderId: payload.orderId,
            sourceId: payload.source,
            observationKey,
            status: payload.sourceStatus ?? ORDER_SOURCE_STATUS.Active,
            declaration: true,
            quantity: payload.quantity,
            sourceObservedAt: payload.observedAt,
            validUntil,
            now: now * 1_000,
        });
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
            quantity: null,
            originalQuantity: declaredOrderQuantity({
                ...payload,
                seaportData: mergedSeaportData,
            }),
            price: quote.price,
            currency: quote.currency,
            validFrom,
            validUntil,
            fillabilityStatus: ORDER_STATUS.Unvalidated,
            sourceStatus: observation.availability,
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
        const ready = orderDeclarationReady({
            id: payload.orderId,
            kind: payload.kind,
            maker,
            seaportData: mergedSeaportData,
        })
            ? 1
            : 0;
        db.prepare(
            "UPDATE orders SET validation_ready=? WHERE chain_id=? AND id=? AND validation_ready<>?",
        ).run(ready, payload.chainId, payload.orderId, ready);
        if (retired) this.retirements.forget(payload.chainId, payload.orderId);
        return {
            changed: result.changes > 0,
            validationNeeded: observation.changed || result.changes > 0,
            observationKey,
        };
    }

    private selectMakerUpdateCandidates(
        payload: OrderUpdateByMakerPayload,
        afterId = "",
        boundary: MakerPassBoundary = {
            upperOrderId: "\uffff",
            upperRowId: Number.MAX_SAFE_INTEGER,
        },
        limit: number = STORAGE_POLICY.maintenanceBatchRows,
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
                ...boundary,
                batchLimit: limit,
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
                ...boundary,
                batchLimit: limit,
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
                    ...boundary,
                    batchLimit: limit,
                }) as OrderRow[];
            case GLOBAL_MAKER_TRIGGER_REASON.OrderCounter:
                return this.selectMakerSeaportOrders.all({
                    chainId: payload.chainId,
                    maker,
                    ...activeRevalidatableOrderParams(),
                    nowSeconds: this.nowSeconds(),
                    afterId,
                    ...boundary,
                    batchLimit: limit,
                }) as OrderRow[];
        }
    }

    validationCandidate(request: OrderValidationRequest) {
        const row = this.selectOrderById.get({
            chainId: request.chainId,
            orderId: request.orderId,
        }) as OrderRow | undefined;
        if (!row) return null;
        const order = mapOrderRow(row);
        if (
            !needsCurrentOrderValidation(order, this.nowSeconds()) ||
            !this.canMutateCurrentStateForCollection(
                row.chain_id,
                row.collection_id,
                request.anchorIndependent ? null : request.minimumBlock,
            )
        )
            return null;
        return { order, revision: row.state_revision };
    }

    applyDemandValidation(
        claim: ClaimedOrderValidation,
        result: Awaited<ReturnType<OrderValidator>>,
        proof: OrderValidationEvidence,
    ): number | null {
        const current = this.validationCandidate({
            ...claim.demand,
            minimumBlock: claim.demand.anchorIndependent
                ? null
                : claim.demand.minimumBlock,
        });
        if (!current || current.revision !== claim.candidate.revision)
            return null;
        const row = this.selectOrderById.get({
            chainId: claim.demand.chainId,
            orderId: claim.demand.orderId,
        }) as OrderRow;
        this.applyValidation(row, result, proof.block);
        const updated = this.selectOrderById.get({
            chainId: claim.demand.chainId,
            orderId: claim.demand.orderId,
        }) as OrderRow;
        // Proof provenance is independent of demand retention and of the older
        // lifecycle attribution that first established an unchanged result.
        db.prepare(
            "UPDATE orders SET proof_block_number=?,proof_block_hash=?,proof_admission_sequence=CASE WHEN proof_chain_revision=? THEN MAX(proof_admission_sequence,?) ELSE ? END,proof_chain_revision=?,proof_order_revision=?,proof_at=? WHERE chain_id=? AND id=?",
        ).run(
            proof.block.number,
            proof.block.hash,
            proof.checkpoint.revision,
            proof.admissionSequence,
            proof.admissionSequence,
            proof.checkpoint.revision,
            updated.state_revision,
            proof.observedAt,
            row.chain_id,
            row.id,
        );
        return updated.state_revision;
    }

    refreshValidationProjection(
        chainId: number,
        orderId: string,
        nowMs: number,
    ): void {
        if (!db.raw.inTransaction)
            throw new Error(
                "Validation projection requires the validation writer",
            );
        this.listingPrices.refreshOrder(
            chainId,
            orderId,
            Math.floor(nowMs / 1_000),
        );
    }

    captureMakerPass(): MakerPassBoundary {
        const row = db
            .prepare(
                "SELECT COALESCE((SELECT MAX(id) FROM orders), '') AS upperOrderId, COALESCE((SELECT MAX(rowid) FROM orders), 0) AS upperRowId",
            )
            .get() as MakerPassBoundary;
        return row;
    }

    selectMakerCandidates(
        payload: OrderUpdateByMakerPayload,
        afterId: string,
        boundary: MakerPassBoundary,
        limit: number,
    ): MakerValidationCandidate[] {
        return this.selectMakerUpdateCandidates(
            payload,
            afterId,
            boundary,
            limit,
        ).map((row) => ({
            order: mapOrderRow(row),
            revision: row.state_revision,
            currentAtTrigger: this.canMutateCurrentStateForCollection(
                payload.chainId,
                row.collection_id,
                payload.blockNumber,
            ),
        }));
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
        originalQuantity: row.original_quantity,
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
    "nowSeconds" | "afterId" | "batchLimit" | "upperOrderId" | "upperRowId"
> {
    return {
        sourceStatus: ORDER_SOURCE_STATUS.Active,
        fillableStatus: ORDER_REVALIDATABLE_FILLABILITY_STATUS.Fillable,
        noBalanceStatus: ORDER_REVALIDATABLE_FILLABILITY_STATUS.NoBalance,
        noApprovalStatus: ORDER_REVALIDATABLE_FILLABILITY_STATUS.NoApproval,
        unvalidatedStatus: ORDER_REVALIDATABLE_FILLABILITY_STATUS.Unvalidated,
    };
}

function resolveSeaportDataSourceKind(
    existing: OrderSeaportDataSourceKind | null,
    incoming: SeaportOrderData | null,
    incomingSourceKind: OrderSeaportDataSourceKind,
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

function defaultLocalTokenSetStatus(
    sourceScopeKind: OrderSourceScopeKind,
): OrderLocalTokenSetStatus {
    if (sourceScopeKind === ORDER_SOURCE_SCOPE_KIND.Token) {
        return ORDER_LOCAL_TOKEN_SET_STATUS.None;
    }

    return ORDER_LOCAL_TOKEN_SET_STATUS.Unresolved;
}
