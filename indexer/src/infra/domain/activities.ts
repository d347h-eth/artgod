import { db } from "@artgod/shared/database";
import {
    admitsListingObservation,
    listingDayIdentity,
    MARKET_DATA_STORAGE_POLICY,
    retainsOffchainActivity,
} from "@artgod/shared/market-data/storage-policy";
import { logger } from "@artgod/shared/utils";
import { SqliteDailyListingPrices } from "../storage/sqlite-daily-listing-prices.js";
import {
    ACTIVITY_KIND,
    ACTIVITY_PROJECTION_STATE,
    ACTIVITY_SCOPE_KIND,
    ACTIVITY_SOURCE_KIND,
    type ActivityProjectionState,
} from "../../domain/activities.js";
import type { ActivityUpsertPayload } from "../../domain/activity-jobs.js";
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
    block_timestamp: number;
    tx_hash: string;
    log_index: number;
    transfer_standard: string;
};

type FillRow = {
    collection_id: number;
    fill_kind: string;
    order_id: string | null;
    order_side: string | null;
    maker: string | null;
    taker: string | null;
    contract: string;
    token_id: string;
    amount: string | null;
    price: string | null;
    currency: string | null;
    block_number: number;
    block_timestamp: number;
    tx_hash: string;
    log_index: number;
};

type CollectionExtensionEventRow = {
    collection_id: number;
    extension_key: string;
    event_key: string;
    contract: string;
    token_id: string;
    maker: string | null;
    content_hash: string | null;
    block_number: number;
    block_timestamp: number;
    tx_hash: string;
    log_index: number;
    payload_json: string | null;
};

type ActivityIdRow = {
    id: number;
    occurred_at: number;
    listing_price_at: number | null;
};

type NormalizedActivityUpsert = {
    chainId: number;
    collectionId: number;
    scopeKind: string;
    kind: string;
    contract: string;
    tokenId: string | null;
    occurredAt: number;
    sourceKind: string;
    sourceName: string;
    sourceEventKey: string;
    orderId: string | null;
    blockNumber: number | null;
    txHash: string | null;
    logIndex: number | null;
    fromAddress: string | null;
    toAddress: string | null;
    maker: string | null;
    taker: string | null;
    side: "buy" | "sell" | null;
    amount: string | null;
    price: string | null;
    currency: string | null;
    payloadJson: string | null;
    listingPriceAt?: number;
};

export class SqliteActivityDomain implements ActivityDomainPort {
    private readonly prices: SqliteDailyListingPrices;
    constructor(
        currencies: readonly string[],
        private readonly nowSeconds: () => number = () =>
            Math.floor(Date.now() / 1000),
    ) {
        this.prices = new SqliteDailyListingPrices(db.raw, currencies);
    }
    private selectTransfers = db.prepare<[number, number, number]>(
        "SELECT collection_id, contract_address AS contract, token_id, from_address, to_address, amount, block_number, block_timestamp, tx_hash, log_index, kind AS transfer_standard " +
            "FROM nft_transfer_events WHERE chain_id = ? AND block_number >= ? AND block_number <= ?",
    );
    private selectTransfersForCollection = db.prepare<
        [number, number, number, number]
    >(
        "SELECT collection_id, contract_address AS contract, token_id, from_address, to_address, amount, block_number, block_timestamp, tx_hash, log_index, kind AS transfer_standard " +
            "FROM nft_transfer_events WHERE chain_id = ? AND collection_id = ? AND block_number >= ? AND block_number <= ?",
    );
    private selectFills = db.prepare<[number, number, number]>(
        "SELECT collection_id, kind AS fill_kind, order_id, order_side, maker, taker, contract_address AS contract, token_id, amount, price, currency, block_number, block_timestamp, tx_hash, log_index " +
            "FROM fills WHERE chain_id = ? AND block_number >= ? AND block_number <= ?",
    );
    private selectFillsForCollection = db.prepare<
        [number, number, number, number]
    >(
        "SELECT collection_id, kind AS fill_kind, order_id, order_side, maker, taker, contract_address AS contract, token_id, amount, price, currency, block_number, block_timestamp, tx_hash, log_index " +
            "FROM fills WHERE chain_id = ? AND collection_id = ? AND block_number >= ? AND block_number <= ?",
    );
    private selectCollectionExtensionEvents = db.prepare<{
        chainId: number;
        fromBlock: number;
        toBlock: number;
    }>(
        "SELECT collection_id, extension_key, event_key, contract_address AS contract, token_id, maker, content_hash, block_number, block_timestamp, tx_hash, log_index, payload_json " +
            "FROM collection_extension_events WHERE chain_id = @chainId AND block_number >= @fromBlock AND block_number <= @toBlock",
    );
    private selectCollectionExtensionEventsForCollection = db.prepare<{
        chainId: number;
        collectionId: number;
        fromBlock: number;
        toBlock: number;
    }>(
        "SELECT collection_id, extension_key, event_key, contract_address AS contract, token_id, maker, content_hash, block_number, block_timestamp, tx_hash, log_index, payload_json " +
            "FROM collection_extension_events WHERE chain_id = @chainId AND collection_id = @collectionId AND block_number >= @fromBlock AND block_number <= @toBlock",
    );
    private insertActivity = db.prepare<{
        chainId: number;
        collectionId: number;
        scopeKind: string;
        kind: string;
        contract: string;
        tokenId: string | null;
        occurredAt: number;
        sourceKind: string;
        sourceName: string;
        orderId: string | null;
        blockNumber: number | null;
        txHash: string | null;
        logIndex: number | null;
        fromAddress: string | null;
        toAddress: string | null;
        maker: string | null;
        taker: string | null;
        side: string | null;
        amount: string | null;
        price: string | null;
        currency: string | null;
        payloadJson: string | null;
        dedupeKey: string;
        isOpen: number;
        listingDay: number | null;
        listingPriceAt: number | null;
    }>(
        "INSERT OR IGNORE INTO activities " +
            "(chain_id, collection_id, scope_kind, kind, contract_address, token_id, occurred_at, source_kind, source_name, order_id, block_number, tx_hash, log_index, from_address, to_address, maker, taker, side, amount, price, currency, payload_json, dedupe_key, is_open, listing_day, listing_price_at, created_at, updated_at) " +
            "VALUES (@chainId, @collectionId, @scopeKind, @kind, @contract, @tokenId, @occurredAt, @sourceKind, @sourceName, @orderId, @blockNumber, @txHash, @logIndex, @fromAddress, @toAddress, @maker, @taker, @side, @amount, @price, @currency, @payloadJson, @dedupeKey, @isOpen, @listingDay, @listingPriceAt, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
    );
    private selectActivityIdByDedupeKey = db.prepare<{
        chainId: number;
        dedupeKey: string;
    }>(
        "SELECT id, occurred_at, listing_price_at FROM activities WHERE chain_id = @chainId AND dedupe_key = @dedupeKey LIMIT 1",
    );

    async handleDomainSync(context: DomainSyncContext): Promise<void> {
        const { chainId, collectionId, fromBlock, toBlock } = context;
        if (fromBlock > toBlock) return;

        const transferResult = this.persistTransferActivities(
            chainId,
            collectionId,
            fromBlock,
            toBlock,
        );
        const saleResult = this.persistSaleActivities(
            chainId,
            collectionId,
            fromBlock,
            toBlock,
        );
        const extensionResult = this.persistCollectionExtensionActivities(
            chainId,
            collectionId,
            fromBlock,
            toBlock,
        );

        logger.debug("Activity domain sync applied", {
            component: "ActivityDomain",
            action: "handleDomainSync",
            chainId,
            fromBlock,
            toBlock,
            transfers: transferResult,
            sales: saleResult,
            extensions: extensionResult,
        });
    }

    async handleActivityUpsert(payload: ActivityUpsertPayload): Promise<void> {
        // Reject irrelevant or malformed history before acquiring the writer lock.
        if (
            payload.sourceKind === ACTIVITY_SOURCE_KIND.Offchain &&
            (!retainsOffchainActivity(payload.kind) ||
                !payload.orderId ||
                !payload.tokenId ||
                !payload.maker ||
                !admitsListingObservation(
                    payload.occurredAt,
                    this.nowSeconds(),
                ))
        )
            return;
        const normalized = normalizeActivityUpsert(payload);
        const run = db.writeTransaction(() =>
            this.applyActivityUpsert(normalized),
        );
        run();
    }

    private applyActivityUpsert(payload: NormalizedActivityUpsert): void {
        if (
            !db
                .prepare(
                    "SELECT 1 FROM collections WHERE chain_id=? AND collection_id=?",
                )
                .get(payload.chainId, payload.collectionId)
        )
            return;
        const daily = payload.kind === ACTIVITY_KIND.ListingCreated;
        if (daily && (!payload.tokenId || !payload.maker)) return;
        const now = this.nowSeconds();
        // Late historical events retain their own historical price. Today's
        // events use the best known current ask, even if that order began earlier.
        const ask =
            daily &&
            Math.floor(
                payload.occurredAt / MARKET_DATA_STORAGE_POLICY.utcDaySeconds,
            ) === Math.floor(now / MARKET_DATA_STORAGE_POLICY.utcDaySeconds)
                ? this.prices.bestAsk(
                      {
                          chain_id: payload.chainId,
                          collection_id: payload.collectionId,
                          token_id: payload.tokenId,
                          maker: payload.maker!,
                      },
                      now,
                  )
                : undefined;
        this.insertDirectActivity(
            daily
                ? {
                      ...payload,
                      orderId: ask?.id ?? payload.orderId,
                      price: ask?.price ?? payload.price,
                      currency: ask?.currency ?? payload.currency,
                      amount: ask?.quantity ?? payload.amount,
                      listingPriceAt: ask ? now : payload.occurredAt,
                      payloadJson: null,
                  }
                : payload,
            ACTIVITY_PROJECTION_STATE.Closed,
        );
    }

    private insertDirectActivity(
        payload: NormalizedActivityUpsert,
        projectionState: ActivityProjectionState,
    ): number {
        const dedupeKey =
            payload.kind === ACTIVITY_KIND.ListingCreated
                ? listingDayIdentity(
                      payload.collectionId,
                      payload.tokenId!,
                      payload.maker!,
                      payload.occurredAt,
                  )
                : buildActivityDedupeKey(
                      payload.sourceKind,
                      payload.sourceName,
                      payload.sourceEventKey,
                  );
        // Duplicate delivery must not even advance AUTOINCREMENT.
        const existing = this.selectActivityIdByDedupeKey.get({
            chainId: payload.chainId,
            dedupeKey,
        }) as ActivityIdRow | undefined;
        if (existing) {
            // Out-of-order earlier events can correct the first time downwards;
            // later events never promote the row, though its price may change.
            if (
                payload.kind === ACTIVITY_KIND.ListingCreated &&
                payload.occurredAt < existing.occurred_at
            ) {
                db.prepare(
                    "UPDATE activities SET occurred_at=? WHERE id=?",
                ).run(payload.occurredAt, existing.id);
            }
            if (
                payload.kind === ACTIVITY_KIND.ListingCreated &&
                payload.price !== null &&
                (payload.listingPriceAt ?? 0) >=
                    (existing.listing_price_at ?? 0)
            ) {
                db.prepare(
                    "UPDATE activities SET order_id=?,price=?,currency=?,amount=?,listing_price_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND (price,currency,amount) IS NOT (?,?,?)",
                ).run(
                    payload.orderId,
                    payload.price,
                    payload.currency,
                    payload.amount,
                    payload.listingPriceAt,
                    existing.id,
                    payload.price,
                    payload.currency,
                    payload.amount,
                );
            }
            return existing.id;
        }
        this.insertActivity.run({
            chainId: payload.chainId,
            collectionId: payload.collectionId,
            scopeKind: payload.scopeKind,
            kind: payload.kind,
            contract: payload.contract,
            tokenId: payload.tokenId,
            occurredAt: payload.occurredAt,
            sourceKind: payload.sourceKind,
            sourceName: payload.sourceName,
            orderId: payload.orderId,
            blockNumber: payload.blockNumber,
            txHash: payload.txHash,
            logIndex: payload.logIndex,
            fromAddress: payload.fromAddress,
            toAddress: payload.toAddress,
            maker: payload.maker,
            taker: payload.taker,
            side: payload.side,
            amount: payload.amount,
            price: payload.price,
            currency: payload.currency,
            payloadJson: payload.payloadJson,
            dedupeKey,
            isOpen: toStoredActivityOpenFlag(projectionState),
            listingDay:
                payload.kind === ACTIVITY_KIND.ListingCreated
                    ? Math.floor(
                          payload.occurredAt /
                              MARKET_DATA_STORAGE_POLICY.utcDaySeconds,
                      )
                    : null,
            listingPriceAt: payload.listingPriceAt ?? null,
        });
        const row = this.selectActivityIdByDedupeKey.get({
            chainId: payload.chainId,
            dedupeKey,
        }) as ActivityIdRow | undefined;
        if (!row) {
            throw new Error("Failed to resolve activity id after insert");
        }
        return row.id;
    }

    private persistTransferActivities(
        chainId: number,
        collectionId: number | null,
        fromBlock: number,
        toBlock: number,
    ): { rows: number; inserted: number } {
        const rows =
            collectionId === null
                ? (this.selectTransfers.all(
                      chainId,
                      fromBlock,
                      toBlock,
                  ) as TransferRow[])
                : (this.selectTransfersForCollection.all(
                      chainId,
                      collectionId,
                      fromBlock,
                      toBlock,
                  ) as TransferRow[]);
        let inserted = 0;

        for (const row of rows) {
            const result = this.insertActivity.run({
                chainId,
                collectionId: row.collection_id,
                scopeKind: ACTIVITY_SCOPE_KIND.Token,
                kind: ACTIVITY_KIND.Transfer,
                contract: row.contract.toLowerCase(),
                tokenId: row.token_id,
                occurredAt: row.block_timestamp,
                sourceKind: ACTIVITY_SOURCE_KIND.Onchain,
                sourceName: "onchain",
                orderId: null,
                blockNumber: row.block_number,
                txHash: row.tx_hash,
                logIndex: row.log_index,
                fromAddress: row.from_address.toLowerCase(),
                toAddress: row.to_address.toLowerCase(),
                maker: null,
                taker: null,
                side: null,
                amount: row.amount,
                price: null,
                currency: null,
                payloadJson: JSON.stringify({
                    standard: row.transfer_standard,
                }),
                dedupeKey: buildOnchainDedupeKey(
                    ACTIVITY_KIND.Transfer,
                    row.collection_id,
                    row.tx_hash,
                    row.log_index,
                    row.token_id,
                ),
                isOpen: toStoredActivityOpenFlag(
                    ACTIVITY_PROJECTION_STATE.Closed,
                ),
                listingDay: null,
                listingPriceAt: null,
            });
            inserted += result.changes;
        }

        return {
            rows: rows.length,
            inserted,
        };
    }

    private persistSaleActivities(
        chainId: number,
        collectionId: number | null,
        fromBlock: number,
        toBlock: number,
    ): { rows: number; inserted: number } {
        const rows =
            collectionId === null
                ? (this.selectFills.all(
                      chainId,
                      fromBlock,
                      toBlock,
                  ) as FillRow[])
                : (this.selectFillsForCollection.all(
                      chainId,
                      collectionId,
                      fromBlock,
                      toBlock,
                  ) as FillRow[]);
        let inserted = 0;

        for (const row of rows) {
            const maker = normalizeAddress(row.maker);
            const taker = normalizeAddress(row.taker);
            const side = normalizeSide(row.order_side);
            const { fromAddress, toAddress } = resolveSaleParticipants(
                side,
                maker,
                taker,
            );
            const result = this.insertActivity.run({
                chainId,
                collectionId: row.collection_id,
                scopeKind: ACTIVITY_SCOPE_KIND.Token,
                kind: ACTIVITY_KIND.Sale,
                contract: row.contract.toLowerCase(),
                tokenId: row.token_id,
                occurredAt: row.block_timestamp,
                sourceKind: ACTIVITY_SOURCE_KIND.Onchain,
                sourceName: row.fill_kind || "onchain",
                orderId: row.order_id,
                blockNumber: row.block_number,
                txHash: row.tx_hash,
                logIndex: row.log_index,
                fromAddress,
                toAddress,
                maker,
                taker,
                side,
                amount: row.amount,
                price: row.price,
                currency: normalizeAddress(row.currency),
                payloadJson: JSON.stringify({
                    orderKind: row.fill_kind,
                }),
                dedupeKey: buildOnchainDedupeKey(
                    ACTIVITY_KIND.Sale,
                    row.collection_id,
                    row.tx_hash,
                    row.log_index,
                    row.token_id,
                ),
                isOpen: toStoredActivityOpenFlag(
                    ACTIVITY_PROJECTION_STATE.Closed,
                ),
                listingDay: null,
                listingPriceAt: null,
            });
            inserted += result.changes;
        }

        return {
            rows: rows.length,
            inserted,
        };
    }

    private persistCollectionExtensionActivities(
        chainId: number,
        collectionId: number | null,
        fromBlock: number,
        toBlock: number,
    ): { rows: number; inserted: number } {
        const rows =
            collectionId === null
                ? (this.selectCollectionExtensionEvents.all({
                      chainId,
                      fromBlock,
                      toBlock,
                  }) as CollectionExtensionEventRow[])
                : (this.selectCollectionExtensionEventsForCollection.all({
                      chainId,
                      collectionId,
                      fromBlock,
                      toBlock,
                  }) as CollectionExtensionEventRow[]);
        let inserted = 0;

        for (const row of rows) {
            const payload = parseActivityPayloadJson(row.payload_json);
            const tokenId = row.token_id || null;
            const result = this.insertActivity.run({
                chainId,
                collectionId: row.collection_id,
                scopeKind: tokenId
                    ? ACTIVITY_SCOPE_KIND.Token
                    : ACTIVITY_SCOPE_KIND.Collection,
                kind: ACTIVITY_KIND.Custom,
                contract: row.contract.toLowerCase(),
                tokenId,
                occurredAt: row.block_timestamp,
                sourceKind: ACTIVITY_SOURCE_KIND.Extension,
                sourceName: row.extension_key,
                orderId: null,
                blockNumber: row.block_number,
                txHash: row.tx_hash,
                logIndex: row.log_index,
                fromAddress: row.maker?.toLowerCase() ?? null,
                toAddress: null,
                maker: row.maker?.toLowerCase() ?? null,
                taker: null,
                side: null,
                amount: null,
                price: null,
                currency: null,
                payloadJson: JSON.stringify({
                    ...payload,
                    extensionKey: row.extension_key,
                    eventKey: row.event_key,
                    contentHash: row.content_hash?.toLowerCase() ?? null,
                }),
                dedupeKey: buildCollectionExtensionDedupeKey(row),
                isOpen: toStoredActivityOpenFlag(
                    ACTIVITY_PROJECTION_STATE.Closed,
                ),
                listingDay: null,
                listingPriceAt: null,
            });
            inserted += result.changes;
        }

        return {
            rows: rows.length,
            inserted,
        };
    }
}

function buildOnchainDedupeKey(
    kind: string,
    collectionId: number,
    txHash: string,
    logIndex: number,
    tokenId: string,
): string {
    return `${ACTIVITY_SOURCE_KIND.Onchain}:${kind}:${collectionId}:${txHash}:${logIndex}:${tokenId}`;
}

function buildCollectionExtensionDedupeKey(
    row: CollectionExtensionEventRow,
): string {
    return `${ACTIVITY_SOURCE_KIND.Extension}:${row.extension_key}:${row.event_key}:${row.collection_id}:${row.tx_hash}:${row.log_index}:${row.token_id}`;
}

function buildActivityDedupeKey(
    sourceKind: string,
    sourceName: string,
    sourceEventKey: string,
): string {
    return `${sourceKind}:${sourceName}:${sourceEventKey}`;
}

function parseActivityPayloadJson(
    payloadJson: string | null,
): Record<string, unknown> {
    if (!payloadJson) return {};
    try {
        const parsed = JSON.parse(payloadJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
        }
        return parsed as Record<string, unknown>;
    } catch {
        return {};
    }
}

function normalizeActivityUpsert(
    payload: ActivityUpsertPayload,
): NormalizedActivityUpsert {
    if (
        payload.scopeKind === ACTIVITY_SCOPE_KIND.Token &&
        (!payload.tokenId || !payload.tokenId.trim())
    ) {
        throw new Error("Token-scoped activity requires tokenId");
    }

    return {
        chainId: payload.chainId,
        collectionId: payload.collectionId,
        scopeKind: payload.scopeKind,
        kind: payload.kind,
        contract: payload.contract.toLowerCase(),
        tokenId: payload.tokenId?.trim() || null,
        occurredAt: payload.occurredAt,
        sourceKind: payload.sourceKind,
        sourceName: payload.sourceName.toLowerCase(),
        sourceEventKey: payload.sourceEventKey,
        orderId: payload.orderId ?? null,
        blockNumber: payload.blockNumber ?? null,
        txHash: payload.txHash ?? null,
        logIndex: payload.logIndex ?? null,
        fromAddress: normalizeAddress(payload.from),
        toAddress: normalizeAddress(payload.to),
        maker: normalizeAddress(payload.maker),
        taker: normalizeAddress(payload.taker),
        side: normalizeSide(payload.side),
        amount: payload.amount ?? null,
        price: payload.price ?? null,
        currency: normalizeAddress(payload.currency),
        payloadJson: payload.payload ? JSON.stringify(payload.payload) : null,
    };
}

function normalizeAddress(value: string | null | undefined): string | null {
    return value ? value.toLowerCase() : null;
}

function normalizeSide(
    value: string | null | undefined,
): "buy" | "sell" | null {
    return value === "buy" || value === "sell" ? value : null;
}

function toStoredActivityOpenFlag(state: ActivityProjectionState): number {
    return state === ACTIVITY_PROJECTION_STATE.Open ? 1 : 0;
}

function resolveSaleParticipants(
    side: "buy" | "sell" | null,
    maker: string | null,
    taker: string | null,
): { fromAddress: string | null; toAddress: string | null } {
    if (side === "sell") {
        return {
            fromAddress: maker,
            toAddress: taker,
        };
    }
    if (side === "buy") {
        return {
            fromAddress: taker,
            toAddress: maker,
        };
    }
    return {
        fromAddress: maker,
        toAddress: taker,
    };
}
