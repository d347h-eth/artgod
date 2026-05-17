import { db } from "@artgod/shared/database";
import type { BetterSqlite3NamedStatement } from "@artgod/shared/database";
import {
    NOOP_APM,
    type ApmPort,
    type SpanAttributes,
} from "@artgod/shared/observability/apm";
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
    TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
    TRADING_BIDDING_BID_BOOK_PRICE_KIND,
    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
    TRADING_BIDDING_BID_SCOPE_KIND,
    TRADING_BOT_KIND,
    TRADING_BOT_RUNTIME_STATE,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
    type TradingBiddingBidBookSource,
    type TradingBiddingBidScopeKind,
    type TradingBotRuntimeState,
    type TradingJobStatus,
    type TradingTraitCriterion,
    tradingTraitCriteriaKey,
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
    exactBidBookRowPrice,
    marketBidMaterialization,
    persistedBidBookRowEffectiveWei,
    rangeBidBookRowPrice,
} from "../../application/use-cases/trading/bidding-bid-book.js";
import { BIDDING_SPAN_ATTRIBUTE } from "../../application/use-cases/trading/bidding-observability.js";

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

type KnownBiddingMakerRow = {
    address: string;
};

type BiddingJobSignalRow = {
    job_id: string;
    status: TradingJobStatus;
    target_kind: (typeof TRADING_JOB_TARGET_KIND)[keyof typeof TRADING_JOB_TARGET_KIND];
    token_id: string | null;
    floor_wei: string;
    ceiling_wei: string;
    revision: number;
    target_traits_json: string | null;
    quantity: number | null;
    job_updated_at: string;
    current_price_wei: string | null;
    active_order_id: string | null;
    active_protocol_address: string | null;
    active_expiration_time_ms: number | null;
    runtime_updated_at: string | null;
};

type BiddingJobSignal = {
    jobId: string;
    status: TradingJobStatus;
    targetKind: (typeof TRADING_JOB_TARGET_KIND)[keyof typeof TRADING_JOB_TARGET_KIND];
    tokenId: string | null;
    floorWei: string;
    ceilingWei: string;
    revision: number;
    targetTraits: TradingTraitCriterion[];
    quantity: number | null;
    jobUpdatedAt: string;
    runtime: {
        currentPriceWei: string | null;
        activeOrderId: string | null;
        activeProtocolAddress: string | null;
        activeExpirationTimeMs: number | null;
        updatedAt: string;
    } | null;
};

const INDEXED_ORDER_SOURCE_SCOPE_KIND = {
    Token: "token",
    Collection: "collection",
    Attribute: "attribute",
    TokenSet: "token_set",
} as const;

type IndexedOrderSourceScopeKind =
    (typeof INDEXED_ORDER_SOURCE_SCOPE_KIND)[keyof typeof INDEXED_ORDER_SOURCE_SCOPE_KIND];

type IndexedOrderRow = {
    id: string;
    source_scope_kind: IndexedOrderSourceScopeKind;
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
    private readonly selectKnownBiddingMaker: BetterSqlite3NamedStatement<{
        chainId: number;
        botKind: typeof TRADING_BOT_KIND.Bidding;
    }>;
    private readonly selectActiveBiddingJobs: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        botKind: typeof TRADING_BOT_KIND.Bidding;
        archivedStatus: typeof TRADING_JOB_STATUS.Archived;
    }>;
    private readonly selectActiveIndexedOrders: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        nowSeconds: number;
    }>;

    constructor(private readonly apm: ApmPort = NOOP_APM) {
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

        this.selectKnownBiddingMaker = db.prepare<{
            chainId: number;
            botKind: typeof TRADING_BOT_KIND.Bidding;
        }>(
            "SELECT address " +
                "FROM trading_bot_runtime_state " +
                "WHERE chain_id = @chainId AND bot_kind = @botKind " +
                "ORDER BY updated_at DESC, heartbeat_at DESC " +
                "LIMIT 1",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            botKind: typeof TRADING_BOT_KIND.Bidding;
        }>;

        this.selectActiveBiddingJobs = db.prepare<{
            chainId: number;
            collectionId: number;
            botKind: typeof TRADING_BOT_KIND.Bidding;
            archivedStatus: typeof TRADING_JOB_STATUS.Archived;
        }>(
            "SELECT j.job_id, j.status, j.target_kind, j.token_id, j.revision, " +
                "j.updated_at AS job_updated_at, s.floor_wei, s.ceiling_wei, s.quantity, s.target_traits_json, " +
                "r.current_price_wei, r.active_order_id, r.active_protocol_address, r.active_expiration_time_ms, r.updated_at AS runtime_updated_at " +
                "FROM trading_jobs j " +
                "JOIN trading_bidding_job_specs s ON s.job_id = j.job_id " +
                "LEFT JOIN trading_bidding_job_runtime_state r ON r.job_id = j.job_id " +
                "WHERE j.chain_id = @chainId AND j.collection_id = @collectionId " +
                "AND j.bot_kind = @botKind AND j.status != @archivedStatus",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            botKind: typeof TRADING_BOT_KIND.Bidding;
            archivedStatus: typeof TRADING_JOB_STATUS.Archived;
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
        includeOwnJobContext: boolean;
        scopeFilter: CollectionBiddingBidScopeFilter;
        traitFilterJoinMode: CollectionBiddingTraitFilterJoinMode;
        selectedTraits: TraitFilter[];
        selectedTraitRanges: TraitRangeFilter[];
        makerAddress?: string | null;
    }): PersistedBiddingBidBook {
        return this.apm.withSyncSpan(
            "backend.bidding.repository.collection_bid_book",
            collectionBidBookSpanAttributes(params),
            () => this.listCollectionBidBookInner(params),
        );
    }

    listTokenBidBook(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        tokenTraits: TradingTraitCriterion[];
        includeOwnJobContext: boolean;
    }): PersistedBiddingBidBook {
        return this.apm.withSyncSpan(
            "backend.bidding.repository.token_bid_book",
            {
                [BIDDING_SPAN_ATTRIBUTE.ChainId]: params.chainId,
                [BIDDING_SPAN_ATTRIBUTE.CollectionId]: params.collectionId,
                [BIDDING_SPAN_ATTRIBUTE.TokenTraitsCount]:
                    params.tokenTraits.length,
            },
            () => this.listTokenBidBookInner(params),
        );
    }

    private listCollectionBidBookInner(params: {
        chainId: number;
        collectionId: number;
        includeOwnJobContext: boolean;
        scopeFilter: CollectionBiddingBidScopeFilter;
        traitFilterJoinMode: CollectionBiddingTraitFilterJoinMode;
        selectedTraits: TraitFilter[];
        selectedTraitRanges: TraitRangeFilter[];
        makerAddress?: string | null;
    }): PersistedBiddingBidBook {
        const attributes = collectionBidBookSpanAttributes(params);
        const knownMakerAddress = params.includeOwnJobContext
            ? this.apm.withSyncSpan(
                  "backend.bidding.repository.known_maker",
                  baseCollectionSpanAttributes(params),
                  () => this.loadKnownBiddingMakerAddress(params.chainId),
              )
            : null;
        const source = this.apm.withSyncSpan(
            "backend.bidding.repository.source_select",
            attributes,
            () =>
                this.shouldUseBotSnapshot(params)
                    ? TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot
                    : TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
        );
        const rawBidBook =
            source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot
                ? this.loadProjectedBidBook(params.chainId, params.collectionId)
                : this.loadIndexedOrdersBidBook(
                      params.chainId,
                      params.collectionId,
                  );
        const markedBidBook = this.apm.withSyncSpan(
            "backend.bidding.repository.mark_own",
            {
                ...attributes,
                ...bidSummarySpanAttributes(rawBidBook.bids),
                [BIDDING_SPAN_ATTRIBUTE.Source]: source,
                [BIDDING_SPAN_ATTRIBUTE.OwnMakerPresent]:
                    knownMakerAddress !== null,
            },
            () => markOwnBids(rawBidBook, knownMakerAddress),
        );
        const jobs = params.includeOwnJobContext
            ? this.loadActiveBiddingJobs(params.chainId, params.collectionId)
            : [];
        const bidBook = this.apm.withSyncSpan(
            "backend.bidding.repository.own_overlays",
            {
                ...attributes,
                ...bidSummarySpanAttributes(markedBidBook.bids),
                ...jobSummarySpanAttributes(jobs),
                [BIDDING_SPAN_ATTRIBUTE.Source]: source,
                [BIDDING_SPAN_ATTRIBUTE.OwnMakerPresent]:
                    knownMakerAddress !== null,
            },
            () => maybeAddOwnJobOverlays(markedBidBook, jobs, knownMakerAddress),
        );
        const makerAddress = params.makerAddress?.toLowerCase() ?? null;
        const scopedBids = this.apm.withSyncSpan(
            "backend.bidding.repository.collection_filter_sort",
            {
                ...attributes,
                ...bidSummarySpanAttributes(bidBook.bids),
                [BIDDING_SPAN_ATTRIBUTE.Source]: source,
            },
            () =>
                sortBidsDesc(
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
        );
        const signaledBids = this.apm.withSyncSpan(
            "backend.bidding.repository.own_signals",
            {
                ...attributes,
                ...bidSummarySpanAttributes(scopedBids),
                ...jobSummarySpanAttributes(jobs),
                [BIDDING_SPAN_ATTRIBUTE.Source]: source,
            },
            () => attachOwnBidRuntimeSignals(scopedBids, jobs),
        );
        const finalBids = this.apm.withSyncSpan(
            "backend.bidding.repository.maker_filter",
            {
                ...attributes,
                ...bidSummarySpanAttributes(signaledBids),
                [BIDDING_SPAN_ATTRIBUTE.Source]: source,
                [BIDDING_SPAN_ATTRIBUTE.MakerFilterPresent]:
                    makerAddress !== null,
            },
            () =>
                signaledBids.filter((bid) =>
                    makerMatchesFilter(bid, makerAddress),
                ),
        );
        return {
            state: bidBook.state,
            ownMakerAddress: bidBook.ownMakerAddress,
            bids: finalBids,
        };
    }

    private listTokenBidBookInner(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        tokenTraits: TradingTraitCriterion[];
        includeOwnJobContext: boolean;
    }): PersistedBiddingBidBook {
        const attributes = {
            [BIDDING_SPAN_ATTRIBUTE.ChainId]: params.chainId,
            [BIDDING_SPAN_ATTRIBUTE.CollectionId]: params.collectionId,
            [BIDDING_SPAN_ATTRIBUTE.TokenTraitsCount]:
                params.tokenTraits.length,
        };
        const knownMakerAddress = params.includeOwnJobContext
            ? this.apm.withSyncSpan(
                  "backend.bidding.repository.known_maker",
                  baseCollectionSpanAttributes(params),
                  () => this.loadKnownBiddingMakerAddress(params.chainId),
              )
            : null;
        const source = this.apm.withSyncSpan(
            "backend.bidding.repository.source_select",
            attributes,
            () =>
                this.shouldUseBotSnapshot(params)
                    ? TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot
                    : TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
        );
        const rawBidBook =
            source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot
                ? this.loadProjectedBidBook(params.chainId, params.collectionId)
                : this.loadIndexedOrdersBidBook(
                      params.chainId,
                      params.collectionId,
                  );
        const markedBidBook = this.apm.withSyncSpan(
            "backend.bidding.repository.mark_own",
            {
                ...attributes,
                ...bidSummarySpanAttributes(rawBidBook.bids),
                [BIDDING_SPAN_ATTRIBUTE.Source]: source,
                [BIDDING_SPAN_ATTRIBUTE.OwnMakerPresent]:
                    knownMakerAddress !== null,
            },
            () => markOwnBids(rawBidBook, knownMakerAddress),
        );
        const jobs = params.includeOwnJobContext
            ? this.loadActiveBiddingJobs(params.chainId, params.collectionId)
            : [];
        const bidBook = this.apm.withSyncSpan(
            "backend.bidding.repository.own_overlays",
            {
                ...attributes,
                ...bidSummarySpanAttributes(markedBidBook.bids),
                ...jobSummarySpanAttributes(jobs),
                [BIDDING_SPAN_ATTRIBUTE.Source]: source,
                [BIDDING_SPAN_ATTRIBUTE.OwnMakerPresent]:
                    knownMakerAddress !== null,
            },
            () => maybeAddOwnJobOverlays(markedBidBook, jobs, knownMakerAddress),
        );
        const bids = this.apm.withSyncSpan(
            "backend.bidding.repository.token_filter_sort",
            {
                ...attributes,
                ...bidSummarySpanAttributes(bidBook.bids),
                [BIDDING_SPAN_ATTRIBUTE.Source]: source,
            },
            () =>
                sortBidsDesc(
                    bidBook.bids.filter((bid) =>
                        tokenBidApplies(
                            bid,
                            params.tokenId,
                            params.tokenTraits,
                        ),
                    ),
                ),
        );
        return {
            state: bidBook.state,
            ownMakerAddress: bidBook.ownMakerAddress,
            bids: this.apm.withSyncSpan(
                "backend.bidding.repository.own_signals",
                {
                    ...attributes,
                    ...bidSummarySpanAttributes(bids),
                    ...jobSummarySpanAttributes(jobs),
                    [BIDDING_SPAN_ATTRIBUTE.Source]: source,
                },
                () => attachOwnBidRuntimeSignals(bids, jobs),
            ),
        };
    }

    private shouldUseBotSnapshot(params: {
        chainId: number;
        collectionId: number;
    }): boolean {
        const attributes = baseCollectionSpanAttributes(params);
        const hasEnabledJobs = this.apm.withSyncSpan(
            "backend.bidding.repository.source_enabled_jobs",
            attributes,
            () => this.hasEnabledBiddingJobs(params),
        );
        if (!hasEnabledJobs) {
            return false;
        }

        // Check the bot-owned heartbeat before trusting snapshot rows that stop updating when the bot exits.
        const runtimeState = this.apm.withSyncSpan(
            "backend.bidding.repository.source_runtime_state",
            attributes,
            () =>
                this.selectBiddingBotRuntimeState.get({
                    chainId: params.chainId,
                    botKind: TRADING_BOT_KIND.Bidding,
                    state: TRADING_BOT_RUNTIME_STATE.Running,
                }) as BotRuntimeStateRow | undefined,
        );
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
        const projectionState = this.apm.withSyncSpan(
            "backend.bidding.repository.source_projection_state",
            {
                ...attributes,
                [BIDDING_SPAN_ATTRIBUTE.SnapshotStaleMs]:
                    TRADING_BIDDING_BID_BOOK_SNAPSHOT_STALE_MS,
            },
            () =>
                this.selectProjectionState.get({
                    chainId: params.chainId,
                    collectionId: params.collectionId,
                    source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
                }) as ProjectionStateRow | undefined,
        );
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

    private loadKnownBiddingMakerAddress(chainId: number): string | null {
        // Read the latest bot-owned wallet address so passive orders can still mark own bids.
        const row = this.selectKnownBiddingMaker.get({
            chainId,
            botKind: TRADING_BOT_KIND.Bidding,
        }) as KnownBiddingMakerRow | undefined;
        return row?.address?.toLowerCase() ?? null;
    }

    private loadActiveBiddingJobs(
        chainId: number,
        collectionId: number,
    ): BiddingJobSignal[] {
        // Load declared jobs once so own-bid row signals can be computed from backend read models.
        const attributes = {
            chainId,
            collectionId,
        };
        const rows = this.apm.withSyncSpan(
            "backend.bidding.repository.active_jobs_query",
            baseCollectionSpanAttributes(attributes),
            () =>
                this.selectActiveBiddingJobs.all({
                    chainId,
                    collectionId,
                    botKind: TRADING_BOT_KIND.Bidding,
                    archivedStatus: TRADING_JOB_STATUS.Archived,
                }) as BiddingJobSignalRow[],
        );
        return this.apm.withSyncSpan(
            "backend.bidding.repository.active_jobs_map",
            {
                ...baseCollectionSpanAttributes(attributes),
                ...jobRowSummarySpanAttributes(rows),
            },
            () =>
                rows.map((row) => ({
                    jobId: row.job_id,
                    status: row.status,
                    targetKind: row.target_kind,
                    tokenId: row.token_id,
                    floorWei: row.floor_wei,
                    ceilingWei: row.ceiling_wei,
                    revision: row.revision,
                    targetTraits: parseTraitArray(row.target_traits_json),
                    quantity: row.quantity,
                    jobUpdatedAt: row.job_updated_at,
                    runtime: row.runtime_updated_at
                        ? {
                              currentPriceWei: row.current_price_wei,
                              activeOrderId: row.active_order_id,
                              activeProtocolAddress:
                                  row.active_protocol_address,
                              activeExpirationTimeMs:
                                  row.active_expiration_time_ms,
                              updatedAt: row.runtime_updated_at,
                          }
                        : null,
                })),
        );
    }

    private loadProjectedBidBook(
        chainId: number,
        collectionId: number,
    ): PersistedBiddingBidBook {
        const attributes = {
            ...baseCollectionSpanAttributes({ chainId, collectionId }),
            [BIDDING_SPAN_ATTRIBUTE.Source]:
                TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
        };
        const rows = this.apm.withSyncSpan(
            "backend.bidding.repository.projection_rows_query",
            attributes,
            () =>
                this.selectProjectionRows.all({
                    chainId,
                    collectionId,
                    source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
                }) as ProjectedBidBookRow[],
        );
        const stateRow = this.apm.withSyncSpan(
            "backend.bidding.repository.projection_state_query",
            attributes,
            () =>
                this.selectProjectionState.get({
                    chainId,
                    collectionId,
                    source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
                }) as ProjectionStateRow | undefined,
        );
        const bids = this.apm.withSyncSpan(
            "backend.bidding.repository.projection_rows_map",
            {
                ...attributes,
                ...projectionRowSummarySpanAttributes(rows),
            },
            () => rows.flatMap((row) => mapProjectedRow(row)),
        );

        return {
            state: stateRow
                ? mapProjectionStateRow(stateRow)
                : emptyState(TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot),
            ownMakerAddress: null,
            bids,
        };
    }

    private loadIndexedOrdersBidBook(
        chainId: number,
        collectionId: number,
    ): PersistedBiddingBidBook {
        // Load active indexed OpenSea buy orders as the passive bid-book source.
        const attributes = {
            ...baseCollectionSpanAttributes({ chainId, collectionId }),
            [BIDDING_SPAN_ATTRIBUTE.Source]:
                TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
        };
        const rows = this.apm.withSyncSpan(
            "backend.bidding.repository.orders_query",
            attributes,
            () =>
                this.selectActiveIndexedOrders.all({
                    chainId,
                    collectionId,
                    nowSeconds: Math.floor(Date.now() / 1000),
                }) as IndexedOrderRow[],
        );
        const bids = this.apm.withSyncSpan(
            "backend.bidding.repository.orders_map",
            {
                ...attributes,
                ...indexedOrderRowSummarySpanAttributes(rows),
            },
            () => rows.flatMap((row) => mapIndexedOrderRow(row)),
        );
        const updatedAt = this.apm.withSyncSpan(
            "backend.bidding.repository.orders_updated_at",
            {
                ...attributes,
                [BIDDING_SPAN_ATTRIBUTE.OrdersRowsCount]: rows.length,
            },
            () => latestIsoTimestamp(rows.map((row) => row.updated_at)),
        );
        return {
            state: {
                ...emptyState(TRADING_BIDDING_BID_BOOK_SOURCE.Orders),
                updatedAt,
                rowCount: bids.length,
            },
            ownMakerAddress: null,
            bids,
        };
    }
}

function baseCollectionSpanAttributes(params: {
    chainId: number;
    collectionId: number;
}): SpanAttributes {
    return {
        [BIDDING_SPAN_ATTRIBUTE.ChainId]: params.chainId,
        [BIDDING_SPAN_ATTRIBUTE.CollectionId]: params.collectionId,
    };
}

function collectionBidBookSpanAttributes(params: {
    chainId: number;
    collectionId: number;
    scopeFilter: CollectionBiddingBidScopeFilter;
    traitFilterJoinMode: CollectionBiddingTraitFilterJoinMode;
    selectedTraits: TraitFilter[];
    selectedTraitRanges: TraitRangeFilter[];
    makerAddress?: string | null;
}): SpanAttributes {
    return {
        ...baseCollectionSpanAttributes(params),
        [BIDDING_SPAN_ATTRIBUTE.ScopeFilter]: params.scopeFilter,
        [BIDDING_SPAN_ATTRIBUTE.TraitJoin]: params.traitFilterJoinMode,
        [BIDDING_SPAN_ATTRIBUTE.TraitFiltersCount]:
            params.selectedTraits.length,
        [BIDDING_SPAN_ATTRIBUTE.TraitRangesCount]:
            params.selectedTraitRanges.length,
        [BIDDING_SPAN_ATTRIBUTE.MakerFilterPresent]: Boolean(
            params.makerAddress,
        ),
    };
}

function bidSummarySpanAttributes(
    bids: PersistedBiddingBidBookRow[],
): SpanAttributes {
    const scopeCounts = createBiddingScopeCounts();
    let ownBids = 0;
    let encodedTokenIdBids = 0;
    let traitCriteria = 0;

    for (const bid of bids) {
        tallyBiddingScope(scopeCounts, bid.scopeKind);
        if (bid.isOwn) ownBids += 1;
        if (bid.encodedTokenIds) encodedTokenIdBids += 1;
        traitCriteria += bid.scopeTraits.length;
    }

    return {
        [BIDDING_SPAN_ATTRIBUTE.BidsCount]: bids.length,
        [BIDDING_SPAN_ATTRIBUTE.CollectionScopeBidsCount]:
            scopeCounts.collection,
        [BIDDING_SPAN_ATTRIBUTE.TraitScopeBidsCount]: scopeCounts.trait,
        [BIDDING_SPAN_ATTRIBUTE.TokenScopeBidsCount]: scopeCounts.token,
        [BIDDING_SPAN_ATTRIBUTE.TokenSetScopeBidsCount]: scopeCounts.tokenSet,
        [BIDDING_SPAN_ATTRIBUTE.UnknownScopeBidsCount]: scopeCounts.unknown,
        [BIDDING_SPAN_ATTRIBUTE.OwnBidsCount]: ownBids,
        [BIDDING_SPAN_ATTRIBUTE.EncodedTokenIdBidsCount]:
            encodedTokenIdBids,
        [BIDDING_SPAN_ATTRIBUTE.TraitCriteriaCount]: traitCriteria,
    };
}

function projectionRowSummarySpanAttributes(
    rows: ProjectedBidBookRow[],
): SpanAttributes {
    const scopeCounts = createBiddingScopeCounts();
    let ownRows = 0;
    let encodedTokenIdRows = 0;
    let traitJsonRows = 0;

    for (const row of rows) {
        tallyBiddingScope(scopeCounts, row.scope_kind);
        if (row.is_own === 1) ownRows += 1;
        if (row.encoded_token_ids) encodedTokenIdRows += 1;
        if (row.scope_traits_json) traitJsonRows += 1;
    }

    return {
        [BIDDING_SPAN_ATTRIBUTE.ProjectionRowsCount]: rows.length,
        [BIDDING_SPAN_ATTRIBUTE.ProjectionCollectionScopeRowsCount]:
            scopeCounts.collection,
        [BIDDING_SPAN_ATTRIBUTE.ProjectionTraitScopeRowsCount]:
            scopeCounts.trait,
        [BIDDING_SPAN_ATTRIBUTE.ProjectionTokenScopeRowsCount]:
            scopeCounts.token,
        [BIDDING_SPAN_ATTRIBUTE.ProjectionTokenSetScopeRowsCount]:
            scopeCounts.tokenSet,
        [BIDDING_SPAN_ATTRIBUTE.ProjectionUnknownScopeRowsCount]:
            scopeCounts.unknown,
        [BIDDING_SPAN_ATTRIBUTE.ProjectionOwnRowsCount]: ownRows,
        [BIDDING_SPAN_ATTRIBUTE.ProjectionEncodedTokenIdRowsCount]:
            encodedTokenIdRows,
        [BIDDING_SPAN_ATTRIBUTE.ProjectionTraitJsonRowsCount]: traitJsonRows,
    };
}

function indexedOrderRowSummarySpanAttributes(
    rows: IndexedOrderRow[],
): SpanAttributes {
    const scopeCounts = createIndexedOrderScopeCounts();
    let rawRestRows = 0;
    let rawStreamRows = 0;
    let seaportJsonRows = 0;
    let validUntilRows = 0;

    for (const row of rows) {
        tallyIndexedOrderScope(scopeCounts, row.source_scope_kind);
        if (row.raw_rest_data) rawRestRows += 1;
        if (row.raw_stream_data) rawStreamRows += 1;
        if (row.seaport_data_json) seaportJsonRows += 1;
        if (row.valid_until !== null) validUntilRows += 1;
    }

    return {
        [BIDDING_SPAN_ATTRIBUTE.OrdersRowsCount]: rows.length,
        [BIDDING_SPAN_ATTRIBUTE.OrdersCollectionScopeRowsCount]:
            scopeCounts.collection,
        [BIDDING_SPAN_ATTRIBUTE.OrdersAttributeScopeRowsCount]:
            scopeCounts.attribute,
        [BIDDING_SPAN_ATTRIBUTE.OrdersTokenScopeRowsCount]:
            scopeCounts.token,
        [BIDDING_SPAN_ATTRIBUTE.OrdersTokenSetScopeRowsCount]:
            scopeCounts.tokenSet,
        [BIDDING_SPAN_ATTRIBUTE.OrdersRawRestRowsCount]: rawRestRows,
        [BIDDING_SPAN_ATTRIBUTE.OrdersRawStreamRowsCount]: rawStreamRows,
        [BIDDING_SPAN_ATTRIBUTE.OrdersSeaportJsonRowsCount]:
            seaportJsonRows,
        [BIDDING_SPAN_ATTRIBUTE.OrdersValidUntilRowsCount]: validUntilRows,
    };
}

function jobRowSummarySpanAttributes(
    rows: BiddingJobSignalRow[],
): SpanAttributes {
    const statusCounts = createJobStatusCounts();
    const targetCounts = createJobTargetCounts();
    let traitJsonRows = 0;

    for (const row of rows) {
        tallyJobStatus(statusCounts, row.status);
        tallyJobTarget(targetCounts, row.target_kind);
        if (row.target_traits_json) traitJsonRows += 1;
    }

    return {
        [BIDDING_SPAN_ATTRIBUTE.JobsCount]: rows.length,
        [BIDDING_SPAN_ATTRIBUTE.EnabledJobsCount]: statusCounts.enabled,
        [BIDDING_SPAN_ATTRIBUTE.PausedJobsCount]: statusCounts.paused,
        [BIDDING_SPAN_ATTRIBUTE.TokenJobsCount]: targetCounts.token,
        [BIDDING_SPAN_ATTRIBUTE.CollectionJobsCount]:
            targetCounts.collection,
        [BIDDING_SPAN_ATTRIBUTE.CompetitiveTraitJobsCount]:
            targetCounts.competitiveTrait,
        [BIDDING_SPAN_ATTRIBUTE.JobTraitJsonRowsCount]: traitJsonRows,
    };
}

function jobSummarySpanAttributes(jobs: BiddingJobSignal[]): SpanAttributes {
    const statusCounts = createJobStatusCounts();
    const targetCounts = createJobTargetCounts();
    let targetTraits = 0;

    for (const job of jobs) {
        tallyJobStatus(statusCounts, job.status);
        tallyJobTarget(targetCounts, job.targetKind);
        targetTraits += job.targetTraits.length;
    }

    return {
        [BIDDING_SPAN_ATTRIBUTE.JobsCount]: jobs.length,
        [BIDDING_SPAN_ATTRIBUTE.EnabledJobsCount]: statusCounts.enabled,
        [BIDDING_SPAN_ATTRIBUTE.PausedJobsCount]: statusCounts.paused,
        [BIDDING_SPAN_ATTRIBUTE.TokenJobsCount]: targetCounts.token,
        [BIDDING_SPAN_ATTRIBUTE.CollectionJobsCount]:
            targetCounts.collection,
        [BIDDING_SPAN_ATTRIBUTE.CompetitiveTraitJobsCount]:
            targetCounts.competitiveTrait,
        [BIDDING_SPAN_ATTRIBUTE.JobTargetTraitsCount]: targetTraits,
    };
}

type BiddingScopeCounts = {
    collection: number;
    trait: number;
    token: number;
    tokenSet: number;
    unknown: number;
};

function createBiddingScopeCounts(): BiddingScopeCounts {
    return {
        collection: 0,
        trait: 0,
        token: 0,
        tokenSet: 0,
        unknown: 0,
    };
}

function tallyBiddingScope(
    counts: BiddingScopeCounts,
    scopeKind: TradingBiddingBidScopeKind,
): void {
    switch (scopeKind) {
        case TRADING_BIDDING_BID_SCOPE_KIND.Collection:
            counts.collection += 1;
            return;
        case TRADING_BIDDING_BID_SCOPE_KIND.Trait:
            counts.trait += 1;
            return;
        case TRADING_BIDDING_BID_SCOPE_KIND.Token:
            counts.token += 1;
            return;
        case TRADING_BIDDING_BID_SCOPE_KIND.TokenSet:
            counts.tokenSet += 1;
            return;
        default:
            counts.unknown += 1;
    }
}

type IndexedOrderScopeCounts = {
    collection: number;
    attribute: number;
    token: number;
    tokenSet: number;
};

function createIndexedOrderScopeCounts(): IndexedOrderScopeCounts {
    return {
        collection: 0,
        attribute: 0,
        token: 0,
        tokenSet: 0,
    };
}

function tallyIndexedOrderScope(
    counts: IndexedOrderScopeCounts,
    scopeKind: IndexedOrderRow["source_scope_kind"],
): void {
    switch (scopeKind) {
        case INDEXED_ORDER_SOURCE_SCOPE_KIND.Collection:
            counts.collection += 1;
            return;
        case INDEXED_ORDER_SOURCE_SCOPE_KIND.Attribute:
            counts.attribute += 1;
            return;
        case INDEXED_ORDER_SOURCE_SCOPE_KIND.Token:
            counts.token += 1;
            return;
        case INDEXED_ORDER_SOURCE_SCOPE_KIND.TokenSet:
            counts.tokenSet += 1;
    }
}

type JobStatusCounts = {
    enabled: number;
    paused: number;
};

function createJobStatusCounts(): JobStatusCounts {
    return {
        enabled: 0,
        paused: 0,
    };
}

function tallyJobStatus(
    counts: JobStatusCounts,
    status: TradingJobStatus,
): void {
    switch (status) {
        case TRADING_JOB_STATUS.Enabled:
            counts.enabled += 1;
            return;
        case TRADING_JOB_STATUS.Paused:
            counts.paused += 1;
    }
}

type JobTargetCounts = {
    token: number;
    collection: number;
    competitiveTrait: number;
};

function createJobTargetCounts(): JobTargetCounts {
    return {
        token: 0,
        collection: 0,
        competitiveTrait: 0,
    };
}

function tallyJobTarget(
    counts: JobTargetCounts,
    targetKind: BiddingJobSignal["targetKind"],
): void {
    switch (targetKind) {
        case TRADING_JOB_TARGET_KIND.Token:
            counts.token += 1;
            return;
        case TRADING_JOB_TARGET_KIND.Collection:
            counts.collection += 1;
            return;
        case TRADING_JOB_TARGET_KIND.CompetitiveTrait:
            counts.competitiveTrait += 1;
    }
}

function markOwnBids(
    bidBook: PersistedBiddingBidBook,
    ownMakerAddress: string | null,
): PersistedBiddingBidBook {
    if (!ownMakerAddress) {
        return {
            ...bidBook,
            ownMakerAddress: null,
        };
    }

    return {
        ...bidBook,
        ownMakerAddress,
        bids: bidBook.bids.map((bid) => ({
            ...bid,
            isOwn: bid.maker.toLowerCase() === ownMakerAddress,
        })),
    };
}

function maybeAddOwnJobOverlays(
    bidBook: PersistedBiddingBidBook,
    jobs: BiddingJobSignal[],
    ownMakerAddress: string | null,
): PersistedBiddingBidBook {
    if (!ownMakerAddress) {
        return bidBook;
    }

    const overlayRows = jobs.flatMap((job) =>
        shouldCreateOwnJobOverlay(job, bidBook.bids)
            ? [mapJobOverlayRow(job, bidBook.state.source, ownMakerAddress)]
            : [],
    );
    if (overlayRows.length === 0) {
        return bidBook;
    }

    const bids = [...bidBook.bids, ...overlayRows];
    return {
        ...bidBook,
        ownMakerAddress,
        state: {
            ...bidBook.state,
            rowCount: bids.length,
        },
        bids,
    };
}

function shouldCreateOwnJobOverlay(
    job: BiddingJobSignal,
    bids: PersistedBiddingBidBookRow[],
): boolean {
    return !bids.some(
        (bid) =>
            bid.isOwn &&
            ((job.runtime?.activeOrderId &&
                bid.orderId === job.runtime.activeOrderId) ||
                jobMatchesBid(job, bid)),
    );
}

function mapJobOverlayRow(
    job: BiddingJobSignal,
    source: TradingBiddingBidBookSource,
    ownMakerAddress: string,
): PersistedBiddingBidBookRow {
    const activeRuntime =
        job.runtime?.activeOrderId && job.runtime.currentPriceWei
            ? job.runtime
            : null;
    const activeRuntimePriceWei = activeRuntime?.currentPriceWei ?? null;
    const scope = resolveJobBidScope(job);
    const price = activeRuntimePriceWei
        ? exactBidBookRowPrice(activeRuntimePriceWei)
        : rangeBidBookRowPrice({
              floorWei: job.floorWei,
              ceilingWei: job.ceilingWei,
          });

    return {
        orderId: activeRuntime?.activeOrderId ?? `job-intent:${job.jobId}`,
        source,
        materialization: {
            kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
            jobId: job.jobId,
            status: job.status,
            phase:
                job.status === TRADING_JOB_STATUS.Paused
                    ? TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Paused
                    : activeRuntime
                      ? TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.ActiveOrder
                      : TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued,
        },
        scopeKind: scope.kind,
        scopeLabel: scope.label,
        tokenId: scope.tokenId,
        scopeTraits: scope.traits,
        encodedTokenIds: null,
        maker: ownMakerAddress,
        isOwn: true,
        price,
        quantity: String(Math.max(1, Math.floor(job.quantity ?? 1))),
        currencyAddress: null,
        currencySymbol: "WETH",
        protocolAddress: activeRuntime?.activeProtocolAddress ?? null,
        validUntil: activeRuntime?.activeExpirationTimeMs
            ? Math.floor(activeRuntime.activeExpirationTimeMs / 1000)
            : null,
        placedAt: activeRuntime?.updatedAt ?? null,
        snapshotRefreshedAtMs: null,
        seenAt: activeRuntime?.updatedAt ?? job.jobUpdatedAt,
        ownStatus: null,
    };
}

function resolveJobBidScope(job: BiddingJobSignal): {
    kind: TradingBiddingBidScopeKind;
    label: string;
    tokenId: string | null;
    traits: TradingTraitCriterion[];
} {
    if (job.targetKind === TRADING_JOB_TARGET_KIND.Token) {
        return {
            kind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
            label: job.tokenId ? `#${job.tokenId}` : "token",
            tokenId: job.tokenId,
            traits: [],
        };
    }

    if (job.targetTraits.length > 0) {
        return {
            kind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
            label: formatTraitScopeLabel(job.targetTraits),
            tokenId: null,
            traits: job.targetTraits,
        };
    }

    return {
        kind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
        label: "collection",
        tokenId: null,
        traits: [],
    };
}

function formatTraitScopeLabel(traits: TradingTraitCriterion[]): string {
    return traits
        .map((trait) => `${trimTraitText(trait.type)}=${trimTraitText(trait.value)}`)
        .join(" + ");
}

function attachOwnBidRuntimeSignals(
    bids: PersistedBiddingBidBookRow[],
    jobs: BiddingJobSignal[],
): PersistedBiddingBidBookRow[] {
    const bidGroups = groupBidsByExactScope(bids);
    return bids.map((bid) => {
        if (!bid.isOwn) {
            return {
                ...bid,
                ownStatus: null,
            };
        }

        const job =
            jobs.find((candidate) => jobMatchesBid(candidate, bid)) ?? null;
        return {
            ...bid,
            ownStatus: {
                position: resolveOwnBidPosition(
                    bidGroups.get(exactBidScopeKey(bid)) ?? [bid],
                    bid,
                ),
                constraints: job ? resolveOwnBidConstraints(job, bid) : [],
                job: job
                    ? {
                          jobId: job.jobId,
                          revision: job.revision,
                          status: job.status,
                      }
                    : null,
            },
        };
    });
}

function groupBidsByExactScope(
    bids: PersistedBiddingBidBookRow[],
): Map<string, PersistedBiddingBidBookRow[]> {
    const groups = new Map<string, PersistedBiddingBidBookRow[]>();
    for (const bid of bids) {
        const key = exactBidScopeKey(bid);
        const group = groups.get(key) ?? [];
        group.push(bid);
        groups.set(key, group);
    }
    return groups;
}

function exactBidScopeKey(bid: PersistedBiddingBidBookRow): string {
    return [
        bid.scopeKind,
        bid.tokenId ?? "",
        bid.encodedTokenIds ?? "",
        tradingTraitCriteriaKey(bid.scopeTraits),
    ].join("\u0001");
}

function resolveOwnBidPosition(
    bids: PersistedBiddingBidBookRow[],
    ownBid: PersistedBiddingBidBookRow,
): "winning" | "draw" | "losing" {
    const ownPrice = BigInt(persistedBidBookRowEffectiveWei(ownBid));
    const bestOpponent = bids.find((bid) => !bid.isOwn);
    if (
        !bestOpponent ||
        ownPrice > BigInt(persistedBidBookRowEffectiveWei(bestOpponent))
    ) {
        return "winning";
    }
    return ownPrice === BigInt(persistedBidBookRowEffectiveWei(bestOpponent))
        ? "draw"
        : "losing";
}

function resolveOwnBidConstraints(
    job: BiddingJobSignal,
    bid: PersistedBiddingBidBookRow,
): Array<"ceiling" | "floor" | "balance" | "allowance"> {
    if (bid.price.kind === TRADING_BIDDING_BID_BOOK_PRICE_KIND.Range) {
        return [];
    }

    const constraints: Array<"ceiling" | "floor" | "balance" | "allowance"> = [];
    const price = BigInt(persistedBidBookRowEffectiveWei(bid));
    if (price >= BigInt(job.ceilingWei)) {
        constraints.push("ceiling");
    }
    if (price <= BigInt(job.floorWei)) {
        constraints.push("floor");
    }
    return constraints;
}

function jobMatchesBid(
    job: BiddingJobSignal,
    bid: PersistedBiddingBidBookRow,
): boolean {
    if (job.targetKind === TRADING_JOB_TARGET_KIND.Token) {
        return (
            bid.scopeKind === TRADING_BIDDING_BID_SCOPE_KIND.Token &&
            bid.tokenId === job.tokenId
        );
    }

    if (job.targetKind === TRADING_JOB_TARGET_KIND.Collection) {
        return (
            bid.scopeKind ===
                (job.targetTraits.length > 0
                    ? TRADING_BIDDING_BID_SCOPE_KIND.Trait
                    : TRADING_BIDDING_BID_SCOPE_KIND.Collection) &&
            tradingTraitCriteriaKey(bid.scopeTraits) ===
            tradingTraitCriteriaKey(job.targetTraits)
        );
    }

    if (job.targetKind === TRADING_JOB_TARGET_KIND.CompetitiveTrait) {
        return (
            bid.scopeKind === TRADING_BIDDING_BID_SCOPE_KIND.Trait &&
            tradingTraitCriteriaKey(bid.scopeTraits) ===
            tradingTraitCriteriaKey(job.targetTraits)
        );
    }

    return false;
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
            materialization: marketBidMaterialization(),
            scopeKind: row.scope_kind,
            scopeLabel: row.scope_label,
            tokenId: row.token_id,
            scopeTraits,
            encodedTokenIds: row.encoded_token_ids,
            maker: row.maker,
            isOwn: row.is_own === 1,
            price: exactBidBookRowPrice(row.price_wei),
            quantity: row.quantity,
            currencyAddress: row.currency_address,
            currencySymbol: row.currency_symbol,
            protocolAddress: row.protocol_address,
            validUntil: row.valid_until,
            placedAt: row.placed_at,
            snapshotRefreshedAtMs: row.snapshot_refreshed_at_ms,
            seenAt: row.seen_at,
            ownStatus: null,
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
                materialization: marketBidMaterialization(),
                scopeKind: scope.kind,
                scopeLabel: scope.label,
                tokenId: scope.tokenId,
                scopeTraits: scope.traits,
                encodedTokenIds: scope.encodedTokenIds,
                maker: parsed.maker,
                isOwn: false,
                price: exactBidBookRowPrice(parsed.price.toString()),
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
                ownStatus: null,
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

    if (scopeFilter === COLLECTION_BIDDING_BID_SCOPE_FILTER.Token) {
        return (
            bid.scopeKind === TRADING_BIDDING_BID_SCOPE_KIND.Token &&
            bid.tokenId !== null
        );
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

function makerMatchesFilter(
    bid: PersistedBiddingBidBookRow,
    makerAddress: string | null,
): boolean {
    return makerAddress === null || bid.maker.toLowerCase() === makerAddress;
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
        const leftPrice = BigInt(persistedBidBookRowEffectiveWei(left));
        const rightPrice = BigInt(persistedBidBookRowEffectiveWei(right));
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
