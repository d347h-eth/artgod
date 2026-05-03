import { db } from "@artgod/shared/database";
import type { BetterSqlite3NamedStatement } from "@artgod/shared/database";
import {
    parseOpenSeaBiddingOffer,
    type ParsedOpenSeaBiddingOffer,
} from "@artgod/shared/trading/open-sea-bidding-offers";
import { logger } from "@artgod/shared/utils";
import {
    TRADING_BIDDING_BID_BOOK_SNAPSHOT_STALE_MS,
    isFreshEpochMs,
    isTradingBotRuntimeHeartbeatLive,
} from "@artgod/shared/trading/runtime-state";
import {
    TRADING_BIDDING_BID_BOOK_SOURCE,
    TRADING_BIDDING_BID_SCOPE_KIND,
    TRADING_BOT_KIND,
    TRADING_BOT_RUNTIME_STATE,
    TRADING_JOB_STATUS,
    type TradingBiddingBidBookSource,
    type TradingBiddingBidScopeKind,
    type TradingBotRuntimeState,
    type TradingTraitCriterion,
} from "@artgod/shared/types";
import type { TraitFilter, TraitRangeFilter } from "@artgod/shared/types/browse";
import type {
    BiddingBidBookRepositoryPort,
    CollectionBiddingBidScopeFilter,
    CollectionBiddingTraitFilterJoinMode,
    PersistedBiddingBidBook,
    PersistedBiddingBidBookRow,
    PersistedBiddingBidBookState,
} from "../../application/use-cases/trading/bidding-bid-book.js";
import {
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
} from "../../application/use-cases/trading/bidding-bid-book.js";

type ProjectedBidBookRow = {
    order_id: string;
    source: TradingBiddingBidBookSource;
    scope_kind: TradingBiddingBidScopeKind;
    scope_label: string;
    token_id: string | null;
    scope_traits_json: string;
    encoded_token_ids: string | null;
    maker: string;
    is_own: number;
    price_wei: string;
    quantity: string;
    currency_address: string | null;
    currency_symbol: string | null;
    protocol_address: string | null;
    valid_until: number | null;
    placed_at: string | null;
    snapshot_refreshed_at_ms: number | null;
    seen_at: string | null;
};

type ProjectionStateRow = {
    source: TradingBiddingBidBookSource;
    snapshot_refreshed_at_ms: number | null;
    projected_at: string | null;
    row_count: number;
    duration_ms: number | null;
    last_error: string | null;
};

type BotRuntimeStateRow = {
    state: TradingBotRuntimeState;
    heartbeat_at: string | null;
};

type IndexedOrderRow = {
    id: string;
    source_scope_kind: "token" | "collection" | "attribute" | "token_set";
    contract_address: string;
    price: string | null;
    currency: string | null;
    valid_until: number | null;
    seaport_data_json: string | null;
    raw_rest_data: string | null;
    raw_stream_data: string | null;
    created_at: string | null;
    updated_at: string | null;
};

export class SqliteBiddingBidBookRepository
    implements BiddingBidBookRepositoryPort
{
    private readonly selectEnabledJob: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        botKind: typeof TRADING_BOT_KIND.Bidding;
        status: typeof TRADING_JOB_STATUS.Enabled;
    }>;
    private readonly selectProjectionRows: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
    }>;
    private readonly selectProjectionState: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
    }>;
    private readonly selectBiddingBotRuntimeState: BetterSqlite3NamedStatement<{
        chainId: number;
        botKind: typeof TRADING_BOT_KIND.Bidding;
        state: typeof TRADING_BOT_RUNTIME_STATE.Running;
    }>;
    private readonly selectActiveIndexedOrders: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        nowSeconds: number;
    }>;

    constructor() {
        this.selectEnabledJob = db.prepare<{
            chainId: number;
            collectionId: number;
            botKind: typeof TRADING_BOT_KIND.Bidding;
            status: typeof TRADING_JOB_STATUS.Enabled;
        }>(
            "SELECT 1 FROM trading_jobs " +
                "WHERE chain_id = @chainId AND collection_id = @collectionId " +
                "AND bot_kind = @botKind AND status = @status " +
                "LIMIT 1",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            botKind: typeof TRADING_BOT_KIND.Bidding;
            status: typeof TRADING_JOB_STATUS.Enabled;
        }>;

        this.selectProjectionRows = db.prepare<{
            chainId: number;
            collectionId: number;
            source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
        }>(
            "SELECT order_id, source, scope_kind, scope_label, token_id, scope_traits_json, encoded_token_ids, maker, is_own, price_wei, quantity, currency_address, currency_symbol, protocol_address, valid_until, placed_at, snapshot_refreshed_at_ms, seen_at " +
                "FROM trading_bidding_bid_book_rows " +
                "WHERE chain_id = @chainId AND collection_id = @collectionId AND source = @source",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
        }>;

        this.selectProjectionState = db.prepare<{
            chainId: number;
            collectionId: number;
            source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
        }>(
            "SELECT source, snapshot_refreshed_at_ms, projected_at, row_count, duration_ms, last_error " +
                "FROM trading_bidding_collection_bid_book_state " +
                "WHERE chain_id = @chainId AND collection_id = @collectionId AND source = @source " +
                "LIMIT 1",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            source: typeof TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot;
        }>;

        this.selectBiddingBotRuntimeState = db.prepare<{
            chainId: number;
            botKind: typeof TRADING_BOT_KIND.Bidding;
            state: typeof TRADING_BOT_RUNTIME_STATE.Running;
        }>(
            "SELECT state, heartbeat_at " +
                "FROM trading_bot_runtime_state " +
                "WHERE chain_id = @chainId AND bot_kind = @botKind AND state = @state " +
                "ORDER BY heartbeat_at DESC " +
                "LIMIT 1",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            botKind: typeof TRADING_BOT_KIND.Bidding;
            state: typeof TRADING_BOT_RUNTIME_STATE.Running;
        }>;

        this.selectActiveIndexedOrders = db.prepare<{
            chainId: number;
            collectionId: number;
            nowSeconds: number;
        }>(
            "SELECT id, source_scope_kind, contract_address, price, currency, valid_until, seaport_data_json, raw_rest_data, raw_stream_data, created_at, updated_at " +
                "FROM orders " +
                "WHERE chain_id = @chainId AND collection_id = @collectionId " +
                "AND side = 'buy' AND source_status = 'active' AND fillability_status = 'fillable' " +
                "AND price IS NOT NULL AND price != '' " +
                "AND (valid_from IS NULL OR valid_from <= @nowSeconds) " +
                "AND (valid_until IS NULL OR valid_until > @nowSeconds)",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            nowSeconds: number;
        }>;
    }

    listCollectionBidBook(params: {
        chainId: number;
        collectionId: number;
        scopeFilter: CollectionBiddingBidScopeFilter;
        traitFilterJoinMode: CollectionBiddingTraitFilterJoinMode;
        selectedTraits: TraitFilter[];
        selectedTraitRanges: TraitRangeFilter[];
    }): PersistedBiddingBidBook {
        const useProjection = this.shouldUseBotSnapshot(params);
        const bidBook = useProjection
            ? this.loadProjectedBidBook(params.chainId, params.collectionId)
            : this.loadIndexedOrdersBidBook(params.chainId, params.collectionId);
        return {
            state: bidBook.state,
            bids: sortBidsDesc(
                bidBook.bids.filter((bid) =>
                    collectionBidMatchesFilters(
                        bid,
                        params.scopeFilter,
                        params.traitFilterJoinMode,
                        params.selectedTraits,
                        params.selectedTraitRanges,
                    ),
                ),
            ),
        };
    }

    listTokenBidBook(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        tokenTraits: TradingTraitCriterion[];
    }): PersistedBiddingBidBook {
        const useProjection = this.shouldUseBotSnapshot(params);
        const bidBook = useProjection
            ? this.loadProjectedBidBook(params.chainId, params.collectionId)
            : this.loadIndexedOrdersBidBook(params.chainId, params.collectionId);
        return {
            state: bidBook.state,
            bids: sortBidsDesc(
                bidBook.bids.filter((bid) =>
                    tokenBidApplies(bid, params.tokenId, params.tokenTraits),
                ),
            ),
        };
    }

    private shouldUseBotSnapshot(params: {
        chainId: number;
        collectionId: number;
    }): boolean {
        if (!this.hasEnabledBiddingJobs(params)) {
            return false;
        }

        // Check the bot-owned heartbeat before trusting snapshot rows that stop updating when the bot exits.
        const runtimeState = this.selectBiddingBotRuntimeState.get({
            chainId: params.chainId,
            botKind: TRADING_BOT_KIND.Bidding,
            state: TRADING_BOT_RUNTIME_STATE.Running,
        }) as BotRuntimeStateRow | undefined;
        if (
            !isTradingBotRuntimeHeartbeatLive(
                runtimeState
                    ? {
                          state: runtimeState.state,
                          heartbeatAt: runtimeState.heartbeat_at,
                      }
                    : null,
            )
        ) {
            return false;
        }

        // Check projection metadata before loading bot-snapshot rows so stale data falls back to indexed orders.
        const projectionState = this.selectProjectionState.get({
            chainId: params.chainId,
            collectionId: params.collectionId,
            source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
        }) as ProjectionStateRow | undefined;
        return isFreshProjectionState(projectionState);
    }

    private hasEnabledBiddingJobs(params: {
        chainId: number;
        collectionId: number;
    }): boolean {
        // Detect whether this collection is declared as bot-owned by any enabled bidding job.
        return Boolean(
            this.selectEnabledJob.get({
                chainId: params.chainId,
                collectionId: params.collectionId,
                botKind: TRADING_BOT_KIND.Bidding,
                status: TRADING_JOB_STATUS.Enabled,
            }),
        );
    }

    private loadProjectedBidBook(
        chainId: number,
        collectionId: number,
    ): PersistedBiddingBidBook {
        const rows = this.selectProjectionRows.all({
            chainId,
            collectionId,
            source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
        }) as ProjectedBidBookRow[];
        const stateRow = this.selectProjectionState.get({
            chainId,
            collectionId,
            source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
        }) as ProjectionStateRow | undefined;

        return {
            state: stateRow
                ? mapProjectionStateRow(stateRow)
                : emptyState(TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot),
            bids: rows.flatMap((row) => mapProjectedRow(row)),
        };
    }

    private loadIndexedOrdersBidBook(
        chainId: number,
        collectionId: number,
    ): PersistedBiddingBidBook {
        // Load active indexed OpenSea buy orders as the passive bid-book source.
        const rows = this.selectActiveIndexedOrders.all({
            chainId,
            collectionId,
            nowSeconds: Math.floor(Date.now() / 1000),
        }) as IndexedOrderRow[];
        const bids = rows.flatMap((row) => mapIndexedOrderRow(row));
        const updatedAt = latestIsoTimestamp(rows.map((row) => row.updated_at));
        return {
            state: {
                ...emptyState(TRADING_BIDDING_BID_BOOK_SOURCE.Orders),
                updatedAt,
                rowCount: bids.length,
            },
            bids,
        };
    }
}

function isFreshProjectionState(row: ProjectionStateRow | undefined): boolean {
    return Boolean(
        row &&
            !row.last_error &&
            isFreshEpochMs(
                row.snapshot_refreshed_at_ms,
                Date.now(),
                TRADING_BIDDING_BID_BOOK_SNAPSHOT_STALE_MS,
            ),
    );
}

function mapProjectionStateRow(
    row: ProjectionStateRow,
): PersistedBiddingBidBookState {
    return {
        source: row.source,
        updatedAt: epochMsToIsoTimestamp(row.snapshot_refreshed_at_ms),
        snapshotRefreshedAtMs: row.snapshot_refreshed_at_ms,
        projectedAt: row.projected_at,
        rowCount: row.row_count,
        durationMs: row.duration_ms,
        lastError: row.last_error,
    };
}

function emptyState(
    source: TradingBiddingBidBookSource,
): PersistedBiddingBidBookState {
    return {
        source,
        updatedAt: null,
        snapshotRefreshedAtMs: null,
        projectedAt: null,
        rowCount: 0,
        durationMs: null,
        lastError: null,
    };
}

function epochMsToIsoTimestamp(value: number | null): string | null {
    return value === null ? null : new Date(value).toISOString().replace(".000Z", "Z");
}

function latestIsoTimestamp(values: Array<string | null>): string | null {
    let latestValue: string | null = null;
    let latestMs = Number.NEGATIVE_INFINITY;

    for (const value of values) {
        if (!value) {
            continue;
        }

        const valueMs = Date.parse(value);
        if (!Number.isFinite(valueMs) || valueMs <= latestMs) {
            continue;
        }

        latestValue = new Date(valueMs).toISOString().replace(".000Z", "Z");
        latestMs = valueMs;
    }

    return latestValue;
}

function mapProjectedRow(row: ProjectedBidBookRow): PersistedBiddingBidBookRow[] {
    const scopeTraits = parseTraitArray(row.scope_traits_json);
    return [
        {
            orderId: row.order_id,
            source: row.source,
            scopeKind: row.scope_kind,
            scopeLabel: row.scope_label,
            tokenId: row.token_id,
            scopeTraits,
            encodedTokenIds: row.encoded_token_ids,
            maker: row.maker,
            isOwn: row.is_own === 1,
            priceWei: row.price_wei,
            quantity: row.quantity,
            currencyAddress: row.currency_address,
            currencySymbol: row.currency_symbol,
            protocolAddress: row.protocol_address,
            validUntil: row.valid_until,
            placedAt: row.placed_at,
            snapshotRefreshedAtMs: row.snapshot_refreshed_at_ms,
            seenAt: row.seen_at,
        },
    ];
}

function mapIndexedOrderRow(row: IndexedOrderRow): PersistedBiddingBidBookRow[] {
    if (!row.price) {
        return [];
    }

    // Parse REST first, then stream, so malformed primary payloads still get a shared-parser retry.
    const parsed = parseIndexedOpenSeaOrderPayload(row);
    if (parsed) {
        const scope = parsed.bidScope;
        return [
            {
                orderId: row.id,
                source: TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
                scopeKind: scope.kind,
                scopeLabel: scope.label,
                tokenId: scope.tokenId,
                scopeTraits: scope.traits,
                encodedTokenIds: scope.encodedTokenIds,
                maker: parsed.maker,
                isOwn: false,
                priceWei: parsed.price.toString(),
                quantity: parsed.quantity.toString(),
                currencyAddress: row.currency,
                currencySymbol: null,
                protocolAddress:
                    parsed.protocolAddress ??
                    parseProtocolAddress(row.seaport_data_json),
                validUntil: parsed.expirationTime ?? row.valid_until,
                placedAt: parsed.createdAt ?? row.created_at,
                snapshotRefreshedAtMs: null,
                seenAt: row.updated_at,
            },
        ];
    }

    logger.error("OpenSea buy offer shared parser failed", {
        component: "SqliteBiddingBidBookRepository",
        action: "mapIndexedOrderRow",
        reason: "shared-parser-returned-null",
        orderId: row.id,
        sourceScopeKind: row.source_scope_kind,
        hasRawRestData: row.raw_rest_data !== null,
        hasRawStreamData: row.raw_stream_data !== null,
    });
    return [];
}

function parseIndexedOpenSeaOrderPayload(
    row: IndexedOrderRow,
): ParsedOpenSeaBiddingOffer | null {
    const options = {
        collectionAddress: row.contract_address,
        wethAddress: row.currency ?? undefined,
        discoverySource: "collectionOffers" as const,
    };

    for (const payload of [
        parseStoredOpenSeaOrderPayload(row.raw_rest_data),
        parseStoredOpenSeaOrderPayload(row.raw_stream_data),
    ]) {
        if (!payload) {
            continue;
        }

        const parsed = parseOpenSeaBiddingOffer(payload, options);
        if (parsed) {
            return parsed;
        }
    }

    return null;
}

function parseStoredOpenSeaOrderPayload(value: string | null): unknown | null {
    if (!value) {
        return null;
    }

    try {
        const parsed = JSON.parse(value);
        const record = parsed as Record<string, unknown>;
        return record.payload && typeof record.payload === "object"
            ? record.payload
            : parsed;
    } catch {
        return null;
    }
}

function collectionBidMatchesFilters(
    bid: PersistedBiddingBidBookRow,
    scopeFilter: CollectionBiddingBidScopeFilter,
    traitFilterJoinMode: CollectionBiddingTraitFilterJoinMode,
    selectedTraits: TraitFilter[],
    selectedTraitRanges: TraitRangeFilter[],
): boolean {
    if (scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection) {
        return bid.scopeKind === TRADING_BIDDING_BID_SCOPE_KIND.Collection;
    }

    if (bid.scopeKind !== TRADING_BIDDING_BID_SCOPE_KIND.Trait) {
        return false;
    }

    if (selectedTraits.length === 0 && selectedTraitRanges.length === 0) {
        return true;
    }

    return traitFilterJoinMode === COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or
        ? traitScopeMatchesAnyFilter(
              bid.scopeTraits,
              selectedTraits,
              selectedTraitRanges,
          )
        : traitScopeMatchesAllFilters(
              bid.scopeTraits,
              selectedTraits,
              selectedTraitRanges,
          );
}

function tokenBidApplies(
    bid: PersistedBiddingBidBookRow,
    tokenId: string,
    tokenTraits: TradingTraitCriterion[],
): boolean {
    if (bid.scopeKind === TRADING_BIDDING_BID_SCOPE_KIND.Collection) {
        return true;
    }

    if (bid.scopeKind === TRADING_BIDDING_BID_SCOPE_KIND.Token) {
        return bid.tokenId === tokenId;
    }

    if (bid.scopeKind === TRADING_BIDDING_BID_SCOPE_KIND.TokenSet) {
        return bid.encodedTokenIds
            ? encodedTokenIdsContain(bid.encodedTokenIds, tokenId)
            : false;
    }

    if (bid.scopeKind === TRADING_BIDDING_BID_SCOPE_KIND.Trait) {
        return bid.scopeTraits.every((criterion) =>
            tokenTraits.some(
                (trait) =>
                    trait.type === criterion.type &&
                    trait.value === criterion.value,
            ),
        );
    }

    return false;
}

function traitScopeMatchesAllFilters(
    criteria: TradingTraitCriterion[],
    selectedTraits: TraitFilter[],
    selectedTraitRanges: TraitRangeFilter[],
): boolean {
    if (criteria.length === 0) {
        return false;
    }

    return (
        traitScopeCoveredByFilters(
            criteria,
            selectedTraits,
            selectedTraitRanges,
        ) &&
        filtersCoveredByTraitScope(
            criteria,
            selectedTraits,
            selectedTraitRanges,
        )
    );
}

function traitScopeCoveredByFilters(
    criteria: TradingTraitCriterion[],
    selectedTraits: TraitFilter[],
    selectedTraitRanges: TraitRangeFilter[],
): boolean {
    for (const criterion of criteria) {
        const sameTypeSelectedTraits = selectedTraits.filter(
            (trait) => trait.key === criterion.type,
        );
        const exactMatch =
            sameTypeSelectedTraits.length > 0 &&
            sameTypeSelectedTraits.some(
                (trait) => trait.value === criterion.value,
            );
        if (sameTypeSelectedTraits.length > 0) {
            if (!exactMatch) {
                return false;
            }
        }

        const range = selectedTraitRanges.find(
            (item) => item.key === criterion.type,
        );
        const rangeMatch = range
            ? traitValueWithinRange(criterion.value, range)
            : false;
        if (range && !rangeMatch) {
            return false;
        }

        if (!exactMatch && !rangeMatch) {
            return false;
        }
    }

    return true;
}

function filtersCoveredByTraitScope(
    criteria: TradingTraitCriterion[],
    selectedTraits: TraitFilter[],
    selectedTraitRanges: TraitRangeFilter[],
): boolean {
    const exactTraitsCovered = selectedTraits.every((trait) =>
        criteria.some(
            (criterion) =>
                criterion.type === trait.key && criterion.value === trait.value,
        ),
    );
    if (!exactTraitsCovered) {
        return false;
    }

    return selectedTraitRanges.every((range) =>
        criteria.some(
            (criterion) =>
                criterion.type === range.key &&
                traitValueWithinRange(criterion.value, range),
        ),
    );
}

function traitScopeMatchesAnyFilter(
    criteria: TradingTraitCriterion[],
    selectedTraits: TraitFilter[],
    selectedTraitRanges: TraitRangeFilter[],
): boolean {
    if (criteria.length === 0) {
        return false;
    }

    return criteria.some(
        (criterion) =>
            selectedTraits.some(
                (trait) =>
                    trait.key === criterion.type &&
                    trait.value === criterion.value,
            ) ||
            selectedTraitRanges.some(
                (range) =>
                    range.key === criterion.type &&
                    traitValueWithinRange(criterion.value, range),
            ),
    );
}

function traitValueWithinRange(value: string, range: TraitRangeFilter): boolean {
    if (!/^\d+$/.test(value)) {
        return false;
    }
    const numeric = BigInt(value);
    if (range.fromValue !== null && numeric < BigInt(range.fromValue)) {
        return false;
    }
    if (range.toValue !== null && numeric > BigInt(range.toValue)) {
        return false;
    }
    return true;
}

function sortBidsDesc(
    bids: PersistedBiddingBidBookRow[],
): PersistedBiddingBidBookRow[] {
    return [...bids].sort((left, right) => {
        const leftPrice = BigInt(left.priceWei);
        const rightPrice = BigInt(right.priceWei);
        if (leftPrice === rightPrice) {
            return left.orderId.localeCompare(right.orderId);
        }
        return leftPrice > rightPrice ? -1 : 1;
    });
}

function parseTraitArray(value: string | null): TradingTraitCriterion[] {
    if (!value) {
        return [];
    }

    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.flatMap((entry) => {
            const record = entry as { type?: unknown; value?: unknown };
            if (
                typeof record.type !== "string" ||
                typeof record.value !== "string"
            ) {
                return [];
            }
            return [
                {
                    type: trimTraitText(record.type),
                    value: trimTraitText(record.value),
                },
            ];
        });
    } catch {
        return [];
    }
}

function trimTraitText(value: string): string {
    const maxLength = 96;
    const trimmed = value.trim();
    return trimmed.length <= maxLength
        ? trimmed
        : `${trimmed.slice(0, maxLength - 3)}...`;
}

function parseProtocolAddress(value: string | null): string | null {
    if (!value) {
        return null;
    }

    try {
        const parsed = JSON.parse(value) as { protocolAddress?: unknown };
        return typeof parsed.protocolAddress === "string"
            ? parsed.protocolAddress
            : null;
    } catch {
        return null;
    }
}

function encodedTokenIdsContain(
    encodedTokenIds: string,
    tokenId: string,
): boolean {
    if (encodedTokenIds === "*") {
        return true;
    }
    if (encodedTokenIds === "") {
        return false;
    }

    let target: bigint;
    try {
        target = BigInt(tokenId);
    } catch {
        return false;
    }

    for (const segment of encodedTokenIds.split(",")) {
        if (!segment) {
            continue;
        }

        if (segment.includes(":")) {
            const [startRaw, endRaw] = segment.split(":");
            try {
                const start = BigInt(startRaw);
                const end = BigInt(endRaw);
                if (target >= start && target <= end) {
                    return true;
                }
            } catch {
                return false;
            }
            continue;
        }

        try {
            if (BigInt(segment) === target) {
                return true;
            }
        } catch {
            return false;
        }
    }

    return false;
}
