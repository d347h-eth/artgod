import { db } from "@artgod/shared/database";
import type { BetterSqlite3NamedStatement } from "@artgod/shared/database";
import {
    NOOP_APM,
    type ApmPort,
    type SpanAttributes,
} from "@artgod/shared/observability/apm";
import { isTokenSetAttributeSchema } from "@artgod/shared/types/token-sets";
import { logger } from "@artgod/shared/utils";
import {
    isFreshEpochMs,
    resolveTradingBotLifecycleStatus,
} from "@artgod/shared/trading/runtime-state";
import {
    DEFAULT_BIDDING_BID_BOOK_SNAPSHOT_STALE_MS,
    DEFAULT_BIDDING_RUNTIME_HEARTBEAT_STALE_MS,
} from "@artgod/shared/config/bidding";
import {
    COLLECTION_BIDDING_BID_SCOPE_FILTER,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
    TRADING_BIDDING_AUTHORIZATION_STATUS,
    TRADING_BIDDING_BID_BOOK_SOURCE,
    TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE,
    TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
    TRADING_BIDDING_BID_SCOPE_KIND,
    TRADING_BOT_LIFECYCLE_STATUS,
    TRADING_BOT_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
    formatTradingBiddingBidScopeLabel,
    normalizeTradingTraitText,
    resolveTradingBiddingAuthorizationJobPhase,
    isTradingBiddingJobRuntimeBidPosition,
    isTradingBiddingJobRuntimeConstraint,
    type CollectionBiddingBidScopeFilter,
    type CollectionBiddingTraitFilterJoinMode,
    type TradingBiddingAuthorization,
    type TradingBiddingBidBookSource,
    type TradingBiddingBidScopeKind,
    type TradingBiddingJobRuntimeBidPosition,
    type TradingBiddingJobRuntimeConstraint,
    type TradingBotLifecycleStatus,
    type TradingBotRuntimeState,
    type TradingJobStatus,
    type TradingTraitCriterion,
    tradingTraitCriteriaKey,
} from "@artgod/shared/types";
import type {
    TraitFilter,
    TraitRangeFilter,
} from "@artgod/shared/types/browse";
import type {
    BiddingBidBookRepositoryPort,
    PersistedBiddingBidBook,
    PersistedBiddingBidBookRow,
    PersistedBiddingBidBookState,
} from "../../application/use-cases/trading/bidding-bid-book.js";
import {
    bidBookBidLimits,
    exactBidBookRowPrice,
    isPersistedOwnJobIntentRow,
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
    runtime_session_id: string | null;
    authorization_collection_id: number | null;
    authorization_contract_address: string | null;
    authorization_opensea_slug: string | null;
    authorization_max_unit_bid_wei: string | null;
    authorization_max_quantity: number | null;
    current_contract_address: string;
    current_opensea_slug: string | null;
};

type BiddingBotReadContext = {
    lifecycleStatus: TradingBotLifecycleStatus;
    authorization: TradingBiddingAuthorization;
};

type KnownBiddingMakerRow = {
    address: string;
};

type CompletedOwnCancellationRow = {
    order_id: string;
};

type OwnCancellationSignalRow = BiddingJobSignalRow & {
    cancellation_order_id: string;
    cancellation_job_revision: number | null;
    cancellation_price_wei: string | null;
    cancellation_protocol_address: string | null;
    cancellation_placed_at: string | null;
    cancellation_expiration_time_ms: number | null;
    cancellation_error: string | null;
    cancellation_completed_at: string | null;
    cancellation_updated_at: string;
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
    runtime_job_revision: number | null;
    current_price_wei: string | null;
    active_order_id: string | null;
    active_protocol_address: string | null;
    active_order_placed_at: string | null;
    active_order_verified_at: string | null;
    active_expiration_time_ms: number | null;
    bid_position: string | null;
    bid_constraints_json: string | null;
    competitor_price_wei: string | null;
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
    activeOrder: BiddingJobRuntimeSignal | null;
    runtime: BiddingJobRuntimeSignal | null;
    runtimeHeartbeatLive: boolean;
    phaseOverride?: (typeof TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE)[keyof typeof TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE];
};

type BiddingJobRuntimeSignal = {
    jobRevision: number | null;
    currentPriceWei: string | null;
    activeOrderId: string | null;
    activeProtocolAddress: string | null;
    activeOrderPlacedAt: string | null;
    activeOrderVerifiedAt: string | null;
    activeExpirationTimeMs: number | null;
    bidPosition: TradingBiddingJobRuntimeBidPosition | null;
    bidConstraints: TradingBiddingJobRuntimeConstraint[];
    competitorPriceWei: string | null;
    updatedAt: string;
};

type BiddingJobActiveOrderSignal = BiddingJobRuntimeSignal & {
    activeOrderId: string;
};

type BiddingJobRuntimeDecisionSignal = BiddingJobRuntimeSignal & {
    activeOrderId: string;
    bidPosition: TradingBiddingJobRuntimeBidPosition;
};

type BiddingJobSignalWithActiveOrder = BiddingJobSignal & {
    activeOrder: BiddingJobActiveOrderSignal;
};

type BiddingJobSignalWithRuntimeDecision = BiddingJobSignal & {
    runtime: BiddingJobRuntimeDecisionSignal;
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
    token_id: string | null;
    source_encoded_token_ids: string | null;
    source_schema_json: string | null;
    maker: string;
    price: string | null;
    quantity: string;
    currency: string | null;
    valid_from: number | null;
    valid_until: number | null;
    seaport_data_json: string | null;
    created_at: string | null;
    updated_at: string | null;
};

type IndexedOrderBidScope = {
    kind: TradingBiddingBidScopeKind;
    label: string;
    tokenId: string | null;
    traits: TradingTraitCriterion[];
    encodedTokenIds: string | null;
};

const BIDDING_BID_BOOK_REPOSITORY_LOG = {
    Component: "SqliteBiddingBidBookRepository",
    ActionMapIndexedOrderRow: "mapIndexedOrderRow",
    ReasonInvalidNormalizedScope: "invalid-normalized-scope",
} as const;

// Keeps confirmed cancellation rows readable before suppressing stale indexed order echoes.
const COMPLETED_CANCELLATION_ROW_RETENTION_MS = 3_000;

// Prefixes local job-intent row ids so DOM keys change when the declared job revision changes.
const OWN_JOB_INTENT_ORDER_ID_PREFIX = "job-intent";

// Selects cancellation rows with the job/runtime fields needed to render own order lifecycle state.
const OWN_CANCELLATION_SIGNAL_SELECT_SQL =
    "SELECT j.job_id, j.status, j.target_kind, j.token_id, j.revision, " +
    "j.updated_at AS job_updated_at, s.floor_wei, s.ceiling_wei, s.quantity, s.target_traits_json, " +
    "r.job_revision AS runtime_job_revision, r.current_price_wei, r.active_order_id, r.active_protocol_address, r.active_order_placed_at, r.active_order_verified_at, r.active_expiration_time_ms, " +
    "r.bid_position, r.bid_constraints_json, r.competitor_price_wei, r.updated_at AS runtime_updated_at, " +
    "c.order_id AS cancellation_order_id, c.job_revision AS cancellation_job_revision, c.price_wei AS cancellation_price_wei, " +
    "c.protocol_address AS cancellation_protocol_address, c.placed_at AS cancellation_placed_at, c.expiration_time_ms AS cancellation_expiration_time_ms, " +
    "c.cancellation_error, c.completed_at AS cancellation_completed_at, c.updated_at AS cancellation_updated_at ";

// Joins cancellation rows back to the declared job/spec and optional runtime evidence.
const OWN_CANCELLATION_SIGNAL_FROM_SQL =
    "FROM trading_bidding_order_cancellations c " +
    "JOIN trading_jobs j ON j.job_id = c.job_id " +
    "JOIN trading_bidding_job_specs s ON s.job_id = j.job_id " +
    "LEFT JOIN trading_bidding_job_runtime_state r ON r.job_id = j.job_id " +
    "WHERE c.chain_id = @chainId AND c.collection_id = @collectionId " +
    "AND c.maker = @makerAddress ";

export type SqliteBiddingBidBookRepositoryConfig = {
    snapshotStaleMs: number;
    runtimeHeartbeatStaleMs: number;
};

export class SqliteBiddingBidBookRepository implements BiddingBidBookRepositoryPort {
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
        collectionId: number;
        botKind: typeof TRADING_BOT_KIND.Bidding;
    }>;
    private readonly selectKnownBiddingMaker: BetterSqlite3NamedStatement<{
        chainId: number;
        botKind: typeof TRADING_BOT_KIND.Bidding;
    }>;
    private readonly selectCompletedOwnCancellations: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        makerAddress: string;
    }>;
    private readonly selectIncompleteOwnCancellations: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        makerAddress: string;
    }>;
    private readonly selectRecentCompletedOwnCancellations: BetterSqlite3NamedStatement<{
        chainId: number;
        collectionId: number;
        makerAddress: string;
        completedAfter: string;
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

    constructor(
        private readonly apm: ApmPort = NOOP_APM,
        private readonly config: SqliteBiddingBidBookRepositoryConfig = {
            snapshotStaleMs: DEFAULT_BIDDING_BID_BOOK_SNAPSHOT_STALE_MS,
            runtimeHeartbeatStaleMs: DEFAULT_BIDDING_RUNTIME_HEARTBEAT_STALE_MS,
        },
    ) {
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
            collectionId: number;
            botKind: typeof TRADING_BOT_KIND.Bidding;
        }>(
            "SELECT r.state, r.heartbeat_at, r.runtime_session_id, " +
                "a.collection_id AS authorization_collection_id, " +
                "a.contract_address AS authorization_contract_address, " +
                "a.opensea_slug AS authorization_opensea_slug, " +
                "a.max_unit_bid_wei AS authorization_max_unit_bid_wei, " +
                "a.max_quantity AS authorization_max_quantity, " +
                "c.address AS current_contract_address, c.opensea_slug AS current_opensea_slug " +
                "FROM trading_bot_runtime_state r " +
                "JOIN collections c ON c.chain_id = @chainId AND c.collection_id = @collectionId " +
                "LEFT JOIN trading_bidding_runtime_authorized_collections a " +
                "ON a.runtime_session_id = r.runtime_session_id " +
                "AND a.chain_id = r.chain_id AND a.wallet_id = r.wallet_id " +
                "AND a.collection_id = @collectionId " +
                "WHERE r.chain_id = @chainId AND r.bot_kind = @botKind " +
                "ORDER BY r.heartbeat_at DESC " +
                "LIMIT 1",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            botKind: typeof TRADING_BOT_KIND.Bidding;
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

        this.selectCompletedOwnCancellations = db.prepare<{
            chainId: number;
            collectionId: number;
            makerAddress: string;
        }>(
            "SELECT order_id " +
                "FROM trading_bidding_order_cancellations " +
                "WHERE chain_id = @chainId AND collection_id = @collectionId " +
                "AND maker = @makerAddress " +
                "AND completed_at IS NOT NULL AND cancellation_error IS NULL",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            makerAddress: string;
        }>;

        this.selectIncompleteOwnCancellations = db.prepare<{
            chainId: number;
            collectionId: number;
            makerAddress: string;
        }>(
            OWN_CANCELLATION_SIGNAL_SELECT_SQL +
                OWN_CANCELLATION_SIGNAL_FROM_SQL +
                "AND c.completed_at IS NULL",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            makerAddress: string;
        }>;

        this.selectRecentCompletedOwnCancellations = db.prepare<{
            chainId: number;
            collectionId: number;
            makerAddress: string;
            completedAfter: string;
        }>(
            OWN_CANCELLATION_SIGNAL_SELECT_SQL +
                OWN_CANCELLATION_SIGNAL_FROM_SQL +
                "AND c.completed_at IS NOT NULL AND c.cancellation_error IS NULL " +
                "AND c.completed_at >= @completedAfter",
        ) as BetterSqlite3NamedStatement<{
            chainId: number;
            collectionId: number;
            makerAddress: string;
            completedAfter: string;
        }>;

        this.selectActiveBiddingJobs = db.prepare<{
            chainId: number;
            collectionId: number;
            botKind: typeof TRADING_BOT_KIND.Bidding;
            archivedStatus: typeof TRADING_JOB_STATUS.Archived;
        }>(
            "SELECT j.job_id, j.status, j.target_kind, j.token_id, j.revision, " +
                "j.updated_at AS job_updated_at, s.floor_wei, s.ceiling_wei, s.quantity, s.target_traits_json, " +
                "r.job_revision AS runtime_job_revision, r.current_price_wei, r.active_order_id, r.active_protocol_address, r.active_order_placed_at, r.active_order_verified_at, r.active_expiration_time_ms, " +
                "r.bid_position, r.bid_constraints_json, r.competitor_price_wei, r.updated_at AS runtime_updated_at " +
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
            "SELECT id, source_scope_kind, token_id, source_encoded_token_ids, source_schema_json, maker, price, quantity, currency, valid_from, valid_until, seaport_data_json, created_at, updated_at " +
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
        const biddingBotContext = this.resolveBiddingBotContext(params);
        const biddingBotStatus = biddingBotContext.lifecycleStatus;
        const biddingAuthorization = params.includeOwnJobContext
            ? biddingBotContext.authorization
            : null;
        const runtimeHeartbeatLive =
            biddingBotStatus === TRADING_BOT_LIFECYCLE_STATUS.Active;
        const source = this.apm.withSyncSpan(
            "backend.bidding.repository.source_select",
            attributes,
            () =>
                this.shouldUseBotSnapshot(params, runtimeHeartbeatLive)
                    ? TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot
                    : TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
        );
        const rawBidBook =
            source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot
                ? this.loadProjectedBidBook(
                      params.chainId,
                      params.collectionId,
                      biddingBotStatus,
                      biddingAuthorization,
                  )
                : this.loadIndexedOrdersBidBook(
                      params.chainId,
                      params.collectionId,
                      biddingBotStatus,
                      biddingAuthorization,
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
            ? this.loadOwnBiddingJobSignals(
                  params.chainId,
                  params.collectionId,
                  knownMakerAddress,
                  runtimeHeartbeatLive,
                  biddingAuthorization,
              )
            : [];
        const cancelledOwnOrderIds = this.loadCompletedOwnCancellationOrderIds(
            params.chainId,
            params.collectionId,
            knownMakerAddress,
        );
        const currentOwnBidBook = suppressCancelledOwnMarketRows(
            suppressStaleOwnJobMarketRows(
                markedBidBook,
                jobs,
                knownMakerAddress,
            ),
            cancelledOwnOrderIds,
        );
        const bidBook = this.apm.withSyncSpan(
            "backend.bidding.repository.own_overlays",
            {
                ...attributes,
                ...bidSummarySpanAttributes(currentOwnBidBook.bids),
                ...jobSummarySpanAttributes(jobs),
                [BIDDING_SPAN_ATTRIBUTE.Source]: source,
                [BIDDING_SPAN_ATTRIBUTE.OwnMakerPresent]:
                    knownMakerAddress !== null,
            },
            () => maybeAddOwnJobOverlays(currentOwnBidBook, jobs),
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
            () => attachOwnBidRuntimeSignals(scopedBids, jobs, source),
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
            biddingBotStatus: bidBook.biddingBotStatus,
            biddingAuthorization: bidBook.biddingAuthorization,
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
        const biddingBotContext = this.resolveBiddingBotContext(params);
        const biddingBotStatus = biddingBotContext.lifecycleStatus;
        const biddingAuthorization = params.includeOwnJobContext
            ? biddingBotContext.authorization
            : null;
        const runtimeHeartbeatLive =
            biddingBotStatus === TRADING_BOT_LIFECYCLE_STATUS.Active;
        const source = this.apm.withSyncSpan(
            "backend.bidding.repository.source_select",
            attributes,
            () =>
                this.shouldUseBotSnapshot(params, runtimeHeartbeatLive)
                    ? TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot
                    : TRADING_BIDDING_BID_BOOK_SOURCE.Orders,
        );
        const rawBidBook =
            source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot
                ? this.loadProjectedBidBook(
                      params.chainId,
                      params.collectionId,
                      biddingBotStatus,
                      biddingAuthorization,
                  )
                : this.loadIndexedOrdersBidBook(
                      params.chainId,
                      params.collectionId,
                      biddingBotStatus,
                      biddingAuthorization,
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
            ? this.loadOwnBiddingJobSignals(
                  params.chainId,
                  params.collectionId,
                  knownMakerAddress,
                  runtimeHeartbeatLive,
                  biddingAuthorization,
              )
            : [];
        const cancelledOwnOrderIds = this.loadCompletedOwnCancellationOrderIds(
            params.chainId,
            params.collectionId,
            knownMakerAddress,
        );
        const currentOwnBidBook = suppressCancelledOwnMarketRows(
            suppressStaleOwnJobMarketRows(
                markedBidBook,
                jobs,
                knownMakerAddress,
            ),
            cancelledOwnOrderIds,
        );
        const bidBook = this.apm.withSyncSpan(
            "backend.bidding.repository.own_overlays",
            {
                ...attributes,
                ...bidSummarySpanAttributes(currentOwnBidBook.bids),
                ...jobSummarySpanAttributes(jobs),
                [BIDDING_SPAN_ATTRIBUTE.Source]: source,
                [BIDDING_SPAN_ATTRIBUTE.OwnMakerPresent]:
                    knownMakerAddress !== null,
            },
            () => maybeAddOwnJobOverlays(currentOwnBidBook, jobs),
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
            biddingBotStatus: bidBook.biddingBotStatus,
            biddingAuthorization: bidBook.biddingAuthorization,
            ownMakerAddress: bidBook.ownMakerAddress,
            bids: this.apm.withSyncSpan(
                "backend.bidding.repository.own_signals",
                {
                    ...attributes,
                    ...bidSummarySpanAttributes(bids),
                    ...jobSummarySpanAttributes(jobs),
                    [BIDDING_SPAN_ATTRIBUTE.Source]: source,
                },
                () => attachOwnBidRuntimeSignals(bids, jobs, source),
            ),
        };
    }

    private shouldUseBotSnapshot(
        params: {
            chainId: number;
            collectionId: number;
        },
        runtimeHeartbeatLive: boolean,
    ): boolean {
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
        if (!runtimeHeartbeatLive) {
            return false;
        }

        // Check projection metadata before loading bot-snapshot rows so stale data falls back to indexed orders.
        const projectionState = this.apm.withSyncSpan(
            "backend.bidding.repository.source_projection_state",
            {
                ...attributes,
                [BIDDING_SPAN_ATTRIBUTE.SnapshotStaleMs]:
                    this.config.snapshotStaleMs,
            },
            () =>
                this.selectProjectionState.get({
                    chainId: params.chainId,
                    collectionId: params.collectionId,
                    source: TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot,
                }) as ProjectionStateRow | undefined,
        );
        return isFreshProjectionState(
            projectionState,
            this.config.snapshotStaleMs,
        );
    }

    private resolveBiddingBotContext(params: {
        chainId: number;
        collectionId: number;
    }): BiddingBotReadContext {
        const attributes = baseCollectionSpanAttributes(params);
        // Resolve one bounded lifecycle for source selection, own-runtime verification, and the API read model.
        const runtimeState = this.apm.withSyncSpan(
            "backend.bidding.repository.source_runtime_state",
            attributes,
            () =>
                this.selectBiddingBotRuntimeState.get({
                    chainId: params.chainId,
                    collectionId: params.collectionId,
                    botKind: TRADING_BOT_KIND.Bidding,
                }) as BotRuntimeStateRow | undefined,
        );
        const lifecycleStatus = resolveTradingBotLifecycleStatus(
            runtimeState
                ? {
                      state: runtimeState.state,
                      heartbeatAt: runtimeState.heartbeat_at,
                  }
                : null,
            Date.now(),
            this.config.runtimeHeartbeatStaleMs,
        );
        return {
            lifecycleStatus,
            authorization: resolveBiddingAuthorization(
                runtimeState,
                lifecycleStatus,
            ),
        };
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

    private loadCompletedOwnCancellationOrderIds(
        chainId: number,
        collectionId: number,
        ownMakerAddress: string | null,
    ): Set<string> {
        if (!ownMakerAddress) {
            return new Set();
        }

        // Load completed own cancellation tombstones so stale indexed rows do not reappear after archive/pause.
        const rows = this.selectCompletedOwnCancellations.all({
            chainId,
            collectionId,
            makerAddress: ownMakerAddress,
        }) as CompletedOwnCancellationRow[];
        return new Set(rows.map((row) => row.order_id));
    }

    private loadOwnBiddingJobSignals(
        chainId: number,
        collectionId: number,
        ownMakerAddress: string | null,
        runtimeHeartbeatLive: boolean,
        biddingAuthorization: TradingBiddingAuthorization | null,
    ): BiddingJobSignal[] {
        const activeJobs = this.loadActiveBiddingJobs(
            chainId,
            collectionId,
            runtimeHeartbeatLive,
            biddingAuthorization,
        );
        const cancellationJobs = this.loadIncompleteOwnCancellationJobs(
            chainId,
            collectionId,
            ownMakerAddress,
            runtimeHeartbeatLive,
        );
        const recentlyCancelledJobs =
            this.loadRecentlyCompletedOwnCancellationJobs(
                chainId,
                collectionId,
                ownMakerAddress,
                runtimeHeartbeatLive,
            );
        return mergeOwnBiddingJobSignals(activeJobs, [
            ...cancellationJobs,
            ...recentlyCancelledJobs,
        ]);
    }

    private loadActiveBiddingJobs(
        chainId: number,
        collectionId: number,
        runtimeHeartbeatLive: boolean,
        biddingAuthorization: TradingBiddingAuthorization | null,
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
                rows.map((row) =>
                    applyBiddingAuthorizationPhase(
                        mapBiddingJobSignalRow(row, runtimeHeartbeatLive),
                        biddingAuthorization,
                    ),
                ),
        );
    }

    private loadIncompleteOwnCancellationJobs(
        chainId: number,
        collectionId: number,
        ownMakerAddress: string | null,
        runtimeHeartbeatLive: boolean,
    ): BiddingJobSignal[] {
        if (!ownMakerAddress) {
            return [];
        }

        const rows = this.selectIncompleteOwnCancellations.all({
            chainId,
            collectionId,
            makerAddress: ownMakerAddress,
        }) as OwnCancellationSignalRow[];
        return rows.map((row) =>
            mapCancellationSignalRow(row, runtimeHeartbeatLive),
        );
    }

    private loadRecentlyCompletedOwnCancellationJobs(
        chainId: number,
        collectionId: number,
        ownMakerAddress: string | null,
        runtimeHeartbeatLive: boolean,
    ): BiddingJobSignal[] {
        if (!ownMakerAddress) {
            return [];
        }

        const completedAfter = new Date(
            Date.now() - COMPLETED_CANCELLATION_ROW_RETENTION_MS,
        ).toISOString();
        const rows = this.selectRecentCompletedOwnCancellations.all({
            chainId,
            collectionId,
            makerAddress: ownMakerAddress,
            completedAfter,
        }) as OwnCancellationSignalRow[];
        return rows.map((row) =>
            mapCancellationSignalRow(row, runtimeHeartbeatLive),
        );
    }

    private loadProjectedBidBook(
        chainId: number,
        collectionId: number,
        biddingBotStatus: TradingBotLifecycleStatus,
        biddingAuthorization: TradingBiddingAuthorization | null,
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
            biddingBotStatus,
            biddingAuthorization,
            ownMakerAddress: null,
            bids,
        };
    }

    private loadIndexedOrdersBidBook(
        chainId: number,
        collectionId: number,
        biddingBotStatus: TradingBotLifecycleStatus,
        biddingAuthorization: TradingBiddingAuthorization | null,
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
            biddingBotStatus,
            biddingAuthorization,
            ownMakerAddress: null,
            bids,
        };
    }
}

function resolveBiddingAuthorization(
    runtimeState: BotRuntimeStateRow | undefined,
    lifecycleStatus: TradingBotLifecycleStatus,
): TradingBiddingAuthorization {
    if (lifecycleStatus === TRADING_BOT_LIFECYCLE_STATUS.Inactive) {
        return emptyBiddingAuthorization(
            TRADING_BIDDING_AUTHORIZATION_STATUS.Inactive,
        );
    }
    if (!runtimeState?.runtime_session_id) {
        return emptyBiddingAuthorization(
            TRADING_BIDDING_AUTHORIZATION_STATUS.Unavailable,
        );
    }
    if (runtimeState.authorization_collection_id === null) {
        return emptyBiddingAuthorization(
            TRADING_BIDDING_AUTHORIZATION_STATUS.NotIncluded,
        );
    }
    if (
        !runtimeState.authorization_contract_address ||
        !runtimeState.authorization_opensea_slug ||
        !runtimeState.authorization_max_unit_bid_wei ||
        runtimeState.authorization_max_quantity === null
    ) {
        return emptyBiddingAuthorization(
            TRADING_BIDDING_AUTHORIZATION_STATUS.Unavailable,
        );
    }

    const authorization = {
        maxUnitBidWei: runtimeState.authorization_max_unit_bid_wei,
        maxQuantity: runtimeState.authorization_max_quantity,
    };
    const identityMatches =
        normalizeRuntimeIdentity(
            runtimeState.authorization_contract_address,
        ) === normalizeRuntimeIdentity(runtimeState.current_contract_address) &&
        normalizeRuntimeIdentity(runtimeState.authorization_opensea_slug) ===
            normalizeRuntimeIdentity(runtimeState.current_opensea_slug);
    return {
        status: identityMatches
            ? TRADING_BIDDING_AUTHORIZATION_STATUS.Included
            : TRADING_BIDDING_AUTHORIZATION_STATUS.UpdateRequired,
        ...authorization,
    };
}

function emptyBiddingAuthorization(
    status:
        | typeof TRADING_BIDDING_AUTHORIZATION_STATUS.Inactive
        | typeof TRADING_BIDDING_AUTHORIZATION_STATUS.NotIncluded
        | typeof TRADING_BIDDING_AUTHORIZATION_STATUS.Unavailable,
): TradingBiddingAuthorization {
    return {
        status,
        maxUnitBidWei: null,
        maxQuantity: null,
    };
}

function normalizeRuntimeIdentity(value: string | null): string {
    return value?.trim().toLowerCase() ?? "";
}

function applyBiddingAuthorizationPhase(
    job: BiddingJobSignal,
    authorization: TradingBiddingAuthorization | null,
): BiddingJobSignal {
    if (!authorization || job.status !== TRADING_JOB_STATUS.Enabled) {
        return job;
    }
    const phaseOverride = resolveTradingBiddingAuthorizationJobPhase(
        authorization.status,
    );
    return phaseOverride ? { ...job, phaseOverride } : job;
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
        [BIDDING_SPAN_ATTRIBUTE.EncodedTokenIdBidsCount]: encodedTokenIdBids,
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
    let seaportJsonRows = 0;
    let validUntilRows = 0;

    for (const row of rows) {
        tallyIndexedOrderScope(scopeCounts, row.source_scope_kind);
        if (row.seaport_data_json) seaportJsonRows += 1;
        if (row.valid_until !== null) validUntilRows += 1;
    }

    return {
        [BIDDING_SPAN_ATTRIBUTE.OrdersRowsCount]: rows.length,
        [BIDDING_SPAN_ATTRIBUTE.OrdersCollectionScopeRowsCount]:
            scopeCounts.collection,
        [BIDDING_SPAN_ATTRIBUTE.OrdersAttributeScopeRowsCount]:
            scopeCounts.attribute,
        [BIDDING_SPAN_ATTRIBUTE.OrdersTokenScopeRowsCount]: scopeCounts.token,
        [BIDDING_SPAN_ATTRIBUTE.OrdersTokenSetScopeRowsCount]:
            scopeCounts.tokenSet,
        [BIDDING_SPAN_ATTRIBUTE.OrdersSeaportJsonRowsCount]: seaportJsonRows,
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
        [BIDDING_SPAN_ATTRIBUTE.CollectionJobsCount]: targetCounts.collection,
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
        [BIDDING_SPAN_ATTRIBUTE.CollectionJobsCount]: targetCounts.collection,
        [BIDDING_SPAN_ATTRIBUTE.CompetitiveTraitJobsCount]:
            targetCounts.competitiveTrait,
        [BIDDING_SPAN_ATTRIBUTE.JobTargetTraitsCount]: targetTraits,
    };
}

function mapBiddingJobSignalRow(
    row: BiddingJobSignalRow,
    runtimeHeartbeatLive: boolean,
): BiddingJobSignal {
    const runtime = mapBiddingJobRuntimeSignal(row);
    return {
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
        activeOrder: runtime?.activeOrderId ? runtime : null,
        runtime:
            runtime && row.runtime_job_revision === row.revision
                ? runtime
                : null,
        runtimeHeartbeatLive,
    };
}

function mapBiddingJobRuntimeSignal(
    row: BiddingJobSignalRow,
): BiddingJobRuntimeSignal | null {
    if (!row.runtime_updated_at) {
        return null;
    }

    return {
        jobRevision: row.runtime_job_revision,
        currentPriceWei: row.current_price_wei,
        activeOrderId: row.active_order_id,
        activeProtocolAddress: row.active_protocol_address,
        activeOrderPlacedAt: row.active_order_placed_at,
        activeOrderVerifiedAt: row.active_order_verified_at,
        activeExpirationTimeMs: row.active_expiration_time_ms,
        bidPosition: parseRuntimeBidPosition(row.bid_position),
        bidConstraints: parseRuntimeBidConstraints(row.bid_constraints_json),
        competitorPriceWei: row.competitor_price_wei,
        updatedAt: row.runtime_updated_at,
    };
}

function mapCancellationSignalRow(
    row: OwnCancellationSignalRow,
    runtimeHeartbeatLive: boolean,
): BiddingJobSignal {
    const signal = mapBiddingJobSignalRow(row, runtimeHeartbeatLive);
    const activeOrder = {
        jobRevision: row.cancellation_job_revision ?? signal.revision,
        currentPriceWei: row.cancellation_price_wei,
        activeOrderId: row.cancellation_order_id,
        activeProtocolAddress: row.cancellation_protocol_address,
        activeOrderPlacedAt: row.cancellation_placed_at,
        activeOrderVerifiedAt: row.cancellation_updated_at,
        activeExpirationTimeMs: row.cancellation_expiration_time_ms,
        bidPosition: null,
        bidConstraints: [],
        competitorPriceWei: null,
        updatedAt: row.cancellation_updated_at,
    };
    return {
        ...signal,
        revision: row.cancellation_job_revision ?? signal.revision,
        activeOrder,
        runtime: activeOrder,
        phaseOverride: resolveCancellationPhase(row),
    };
}

function resolveCancellationPhase(
    row: OwnCancellationSignalRow,
): BiddingJobSignal["phaseOverride"] {
    if (row.cancellation_error) {
        return TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.CancelFailed;
    }
    if (row.cancellation_completed_at) {
        return TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Cancelled;
    }
    return TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Canceling;
}

function mergeOwnBiddingJobSignals(
    activeJobs: BiddingJobSignal[],
    cancellationJobs: BiddingJobSignal[],
): BiddingJobSignal[] {
    if (cancellationJobs.length === 0) {
        return activeJobs;
    }

    const cancelingPausedJobIds = new Set(
        cancellationJobs.map((job) => job.jobId),
    );
    return [
        ...activeJobs.filter(
            (job) =>
                job.status === TRADING_JOB_STATUS.Enabled ||
                !cancelingPausedJobIds.has(job.jobId),
        ),
        ...cancellationJobs,
    ];
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
        bids: bidBook.bids.map(
            (bid): PersistedBiddingBidBookRow =>
                isPersistedOwnJobIntentRow(bid)
                    ? bid
                    : {
                          ...bid,
                          isOwn: bid.maker.toLowerCase() === ownMakerAddress,
                      },
        ),
    };
}

function suppressStaleOwnJobMarketRows(
    bidBook: PersistedBiddingBidBook,
    jobs: BiddingJobSignal[],
    ownMakerAddress: string | null,
): PersistedBiddingBidBook {
    if (!ownMakerAddress || jobs.length === 0) {
        return bidBook;
    }

    const bids = bidBook.bids.filter(
        (bid) => !isStaleOwnJobMarketRow(bid, jobs, bidBook.state.source),
    );
    if (bids.length === bidBook.bids.length) {
        return bidBook;
    }

    return {
        ...bidBook,
        state: {
            ...bidBook.state,
            rowCount: bids.length,
        },
        bids,
    };
}

function suppressCancelledOwnMarketRows(
    bidBook: PersistedBiddingBidBook,
    cancelledOwnOrderIds: Set<string>,
): PersistedBiddingBidBook {
    if (cancelledOwnOrderIds.size === 0) {
        return bidBook;
    }

    const bids = bidBook.bids.filter(
        (bid) => !isCancelledOwnMarketRow(bid, cancelledOwnOrderIds),
    );
    if (bids.length === bidBook.bids.length) {
        return bidBook;
    }

    return {
        ...bidBook,
        state: {
            ...bidBook.state,
            rowCount: bids.length,
        },
        bids,
    };
}

function isCancelledOwnMarketRow(
    bid: PersistedBiddingBidBookRow,
    cancelledOwnOrderIds: Set<string>,
): boolean {
    return (
        bid.isOwn &&
        bid.materialization.kind ===
            TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid &&
        cancelledOwnOrderIds.has(bid.orderId)
    );
}

function isStaleOwnJobMarketRow(
    bid: PersistedBiddingBidBookRow,
    jobs: BiddingJobSignal[],
    source: TradingBiddingBidBookSource,
): boolean {
    if (
        !bid.isOwn ||
        bid.materialization.kind !==
            TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid
    ) {
        return false;
    }

    const matchingJobs = jobs.filter((job) => jobMatchesBid(job, bid));
    if (matchingJobs.length === 0) {
        return false;
    }
    if (
        matchingJobs.some(
            (job) =>
                job.phaseOverride ===
                TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Cancelled,
        )
    ) {
        return true;
    }
    if (
        matchingJobs.some(
            (job) =>
                isCancellationPhase(job.phaseOverride) &&
                hasRenderableActiveOrderEvidence(job),
        )
    ) {
        return true;
    }
    if (
        matchingJobs.some(
            (job) =>
                hasRenderableStaleActiveOrderEvidence(job) &&
                activeOrderEvidenceMatchesBid(job, bid),
        )
    ) {
        return true;
    }
    // Orders fallback cannot provide job-authoritative own timing; the job overlay owns local bid display there.
    if (source === TRADING_BIDDING_BID_BOOK_SOURCE.Orders) {
        return true;
    }
    return !matchingJobs.some((job) =>
        currentRuntimeOrderEvidenceMatchesBid(job, bid),
    );
}

function maybeAddOwnJobOverlays(
    bidBook: PersistedBiddingBidBook,
    jobs: BiddingJobSignal[],
): PersistedBiddingBidBook {
    const overlayRows = jobs.flatMap((job) =>
        resolveOwnJobOverlayRows(job, bidBook.bids, bidBook.state.source),
    );
    if (overlayRows.length === 0) {
        return bidBook;
    }

    const bids = [...bidBook.bids, ...overlayRows];
    return {
        ...bidBook,
        state: {
            ...bidBook.state,
            rowCount: bids.length,
        },
        bids,
    };
}

function resolveOwnJobOverlayRows(
    job: BiddingJobSignal,
    bids: PersistedBiddingBidBookRow[],
    source: TradingBiddingBidBookSource,
): PersistedBiddingBidBookRow[] {
    const rows: PersistedBiddingBidBookRow[] = [];
    if (shouldCreateActiveOrderLifecycleOverlay(job)) {
        rows.push(mapActiveOrderLifecycleOverlayRow(job, source));
    }
    if (shouldCreateCurrentJobIntentOverlay(job, bids, source)) {
        rows.push(mapCurrentJobIntentOverlayRow(job, source));
    }
    return rows;
}

function shouldCreateActiveOrderLifecycleOverlay(
    job: BiddingJobSignal,
): boolean {
    if (isCancellationPhase(job.phaseOverride)) {
        return hasRenderableActiveOrderEvidence(job);
    }

    return hasRenderableStaleActiveOrderEvidence(job);
}

function shouldCreateCurrentJobIntentOverlay(
    job: BiddingJobSignal,
    bids: PersistedBiddingBidBookRow[],
    source: TradingBiddingBidBookSource,
): boolean {
    if (isCancellationPhase(job.phaseOverride)) {
        return false;
    }
    if (job.status === TRADING_JOB_STATUS.Archived) {
        return false;
    }
    if (source !== TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot) {
        return true;
    }
    if (!job.runtime?.activeOrderId) {
        return true;
    }
    return !bids.some((bid) => currentRuntimeOrderEvidenceMatchesBid(job, bid));
}

function mapCurrentJobIntentOverlayRow(
    job: BiddingJobSignal,
    source: TradingBiddingBidBookSource,
): PersistedBiddingBidBookRow {
    const activeRuntime =
        job.status === TRADING_JOB_STATUS.Enabled &&
        job.runtime?.activeOrderId &&
        job.runtime.currentPriceWei
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
    const bidLimits = bidBookBidLimits({
        floorWei: job.floorWei,
        ceilingWei: job.ceilingWei,
    });

    return {
        orderId: activeRuntime?.activeOrderId ?? ownJobIntentOrderId(job),
        source,
        materialization: {
            kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
            jobId: job.jobId,
            status: job.status,
            phase: resolveCurrentJobIntentPhase(job, activeRuntime),
        },
        scopeKind: scope.kind,
        scopeLabel: scope.label,
        tokenId: scope.tokenId,
        scopeTraits: scope.traits,
        encodedTokenIds: null,
        maker: null,
        isOwn: true,
        price,
        bidLimits,
        quantity: String(Math.max(1, Math.floor(job.quantity ?? 1))),
        currencyAddress: null,
        currencySymbol: "WETH",
        protocolAddress: activeRuntime?.activeProtocolAddress ?? null,
        validUntil: activeRuntime?.activeExpirationTimeMs
            ? Math.floor(activeRuntime.activeExpirationTimeMs / 1000)
            : null,
        placedAt: activeRuntime?.activeOrderPlacedAt ?? null,
        snapshotRefreshedAtMs: null,
        seenAt: activeRuntime?.updatedAt ?? job.jobUpdatedAt,
        ownStatus: null,
    };
}

function mapActiveOrderLifecycleOverlayRow(
    job: BiddingJobSignal,
    source: TradingBiddingBidBookSource,
): PersistedBiddingBidBookRow {
    const activeOrder = job.activeOrder;
    if (!activeOrder?.activeOrderId || !activeOrder.currentPriceWei) {
        throw new Error(
            "Cannot map own active-order lifecycle row without order evidence",
        );
    }

    const scope = resolveJobBidScope(job);
    return {
        orderId: activeOrder.activeOrderId,
        source,
        materialization: {
            kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent,
            jobId: job.jobId,
            status: job.status,
            phase: resolveActiveOrderLifecyclePhase(job, activeOrder),
        },
        scopeKind: scope.kind,
        scopeLabel: scope.label,
        tokenId: scope.tokenId,
        scopeTraits: scope.traits,
        encodedTokenIds: null,
        maker: null,
        isOwn: true,
        price: exactBidBookRowPrice(activeOrder.currentPriceWei),
        bidLimits: null,
        quantity: String(Math.max(1, Math.floor(job.quantity ?? 1))),
        currencyAddress: null,
        currencySymbol: "WETH",
        protocolAddress: activeOrder.activeProtocolAddress ?? null,
        validUntil: activeOrder.activeExpirationTimeMs
            ? Math.floor(activeOrder.activeExpirationTimeMs / 1000)
            : null,
        placedAt: activeOrder.activeOrderPlacedAt ?? null,
        snapshotRefreshedAtMs: null,
        seenAt: activeOrder.updatedAt,
        ownStatus: null,
    };
}

function ownJobIntentOrderId(job: BiddingJobSignal): string {
    return `${OWN_JOB_INTENT_ORDER_ID_PREFIX}:${job.jobId}:${job.revision}`;
}

function resolveCurrentJobIntentPhase(
    job: BiddingJobSignal,
    activeRuntime: BiddingJobRuntimeSignal | null,
): (typeof TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE)[keyof typeof TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE] {
    if (job.phaseOverride) {
        return job.phaseOverride;
    }
    if (activeRuntime && !isActiveOrderVerified(job, activeRuntime)) {
        return TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Verifying;
    }
    if (job.status === TRADING_JOB_STATUS.Paused) {
        return TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Paused;
    }
    return TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Queued;
}

function resolveActiveOrderLifecyclePhase(
    job: BiddingJobSignal,
    activeOrder: BiddingJobRuntimeSignal,
): (typeof TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE)[keyof typeof TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE] {
    if (job.phaseOverride) {
        return job.phaseOverride;
    }
    if (!isActiveOrderVerified(job, activeOrder)) {
        return TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Verifying;
    }
    return TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Replacing;
}

function isCancellationPhase(
    phase: BiddingJobSignal["phaseOverride"] | null | undefined,
): boolean {
    return (
        phase === TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Canceling ||
        phase === TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.CancelFailed ||
        phase === TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE.Cancelled
    );
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
            label: formatTradingBiddingBidScopeLabel({
                kind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
                traits: job.targetTraits,
            }),
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

function attachOwnBidRuntimeSignals(
    bids: PersistedBiddingBidBookRow[],
    jobs: BiddingJobSignal[],
    source: TradingBiddingBidBookSource,
): PersistedBiddingBidBookRow[] {
    return bids.map((bid) => {
        if (!bid.isOwn || !canAttachRuntimeDecision(source, bid)) {
            return {
                ...bid,
                ownStatus: null,
            };
        }
        if (
            bid.materialization.kind ===
                TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent &&
            isCancellationPhase(bid.materialization.phase)
        ) {
            return {
                ...bid,
                ownStatus: null,
            };
        }

        const job =
            jobs.find((candidate) =>
                activeRuntimeDecisionMatchesBid(candidate, bid),
            ) ?? null;
        return job
            ? mergeRuntimeOwnBidSignals(bid, job)
            : { ...bid, ownStatus: null };
    });
}

function canAttachRuntimeDecision(
    source: TradingBiddingBidBookSource,
    bid: PersistedBiddingBidBookRow,
): boolean {
    if (source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot) {
        return true;
    }

    return (
        bid.materialization.kind ===
        TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent
    );
}

function mapRuntimeOwnStatus(
    job: BiddingJobSignal,
): PersistedBiddingBidBookRow["ownStatus"] {
    const runtime = job.runtime;
    if (!runtime?.bidPosition || !isActiveOrderVerified(job, runtime)) {
        return null;
    }

    return {
        position: runtime.bidPosition,
        constraints: runtime.bidConstraints,
        job: {
            jobId: job.jobId,
            revision: job.revision,
            status: job.status,
        },
    };
}

function mergeRuntimeOwnBidSignals(
    bid: PersistedBiddingBidBookRow,
    job: BiddingJobSignal,
): PersistedBiddingBidBookRow {
    const runtime = job.runtime;
    return {
        ...bid,
        bidLimits: bidBookBidLimits({
            floorWei: job.floorWei,
            ceilingWei: job.ceilingWei,
        }),
        protocolAddress: runtime?.activeProtocolAddress ?? bid.protocolAddress,
        validUntil: runtime?.activeExpirationTimeMs
            ? Math.floor(runtime.activeExpirationTimeMs / 1000)
            : bid.validUntil,
        placedAt: runtime?.activeOrderPlacedAt ?? bid.placedAt,
        seenAt: runtime?.updatedAt ?? bid.seenAt,
        ownStatus: mapRuntimeOwnStatus(job),
    };
}

function activeRuntimeDecisionMatchesBid(
    job: BiddingJobSignal,
    bid: PersistedBiddingBidBookRow,
): job is BiddingJobSignalWithRuntimeDecision {
    return Boolean(activeRuntimeOrderMatchesBid(job, bid));
}

function activeRuntimeOrderMatchesBid(
    job: BiddingJobSignal,
    bid: PersistedBiddingBidBookRow,
): job is BiddingJobSignalWithRuntimeDecision {
    return Boolean(
        bid.isOwn &&
        job.runtime?.activeOrderId &&
        isActiveOrderVerified(job, job.runtime) &&
        job.runtime.bidPosition &&
        bid.orderId === job.runtime.activeOrderId &&
        jobMatchesBid(job, bid),
    );
}

function currentRuntimeOrderEvidenceMatchesBid(
    job: BiddingJobSignal,
    bid: PersistedBiddingBidBookRow,
): boolean {
    return Boolean(
        bid.isOwn &&
        job.runtime?.activeOrderId &&
        isActiveOrderVerified(job, job.runtime) &&
        bid.orderId === job.runtime.activeOrderId &&
        jobMatchesBid(job, bid),
    );
}

function activeOrderEvidenceMatchesBid(
    job: BiddingJobSignal,
    bid: PersistedBiddingBidBookRow,
): job is BiddingJobSignalWithActiveOrder {
    return Boolean(
        bid.isOwn &&
        job.activeOrder?.activeOrderId &&
        bid.orderId === job.activeOrder.activeOrderId &&
        jobMatchesBid(job, bid),
    );
}

function isActiveOrderVerified(
    job: BiddingJobSignal,
    runtime: BiddingJobRuntimeSignal | null | undefined,
): boolean {
    return Boolean(
        job.runtimeHeartbeatLive &&
        runtime?.activeOrderId &&
        runtime.activeOrderVerifiedAt,
    );
}

function hasStaleActiveOrderEvidence(
    job: BiddingJobSignal,
): job is BiddingJobSignalWithActiveOrder {
    return Boolean(
        job.activeOrder?.activeOrderId &&
        job.activeOrder.jobRevision !== null &&
        job.activeOrder.jobRevision !== job.revision,
    );
}

function hasRenderableActiveOrderEvidence(
    job: BiddingJobSignal,
): job is BiddingJobSignalWithActiveOrder {
    return Boolean(
        job.activeOrder?.activeOrderId && job.activeOrder.currentPriceWei,
    );
}

function hasRenderableStaleActiveOrderEvidence(
    job: BiddingJobSignal,
): job is BiddingJobSignalWithActiveOrder {
    return (
        hasStaleActiveOrderEvidence(job) &&
        Boolean(job.activeOrder.currentPriceWei)
    );
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

function isFreshProjectionState(
    row: ProjectionStateRow | undefined,
    snapshotStaleMs: number,
): boolean {
    return Boolean(
        row &&
        !row.last_error &&
        isFreshEpochMs(
            row.snapshot_refreshed_at_ms,
            Date.now(),
            snapshotStaleMs,
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
    return value === null
        ? null
        : new Date(value).toISOString().replace(".000Z", "Z");
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

function mapProjectedRow(
    row: ProjectedBidBookRow,
): PersistedBiddingBidBookRow[] {
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
            bidLimits: null,
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

function mapIndexedOrderRow(
    row: IndexedOrderRow,
): PersistedBiddingBidBookRow[] {
    if (!row.price) {
        return [];
    }

    const scope = resolveIndexedOrderBidScope(row);
    if (scope) {
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
                maker: row.maker.toLowerCase(),
                isOwn: false,
                price: exactBidBookRowPrice(row.price),
                bidLimits: null,
                quantity: row.quantity,
                currencyAddress: row.currency,
                currencySymbol: null,
                protocolAddress: parseProtocolAddress(row.seaport_data_json),
                validUntil: row.valid_until,
                placedAt: indexedOrderPlacedAt(row),
                snapshotRefreshedAtMs: null,
                seenAt: row.updated_at,
                ownStatus: null,
            },
        ];
    }

    logger.error("Indexed buy offer normalized scope mapping failed", {
        component: BIDDING_BID_BOOK_REPOSITORY_LOG.Component,
        action: BIDDING_BID_BOOK_REPOSITORY_LOG.ActionMapIndexedOrderRow,
        reason: BIDDING_BID_BOOK_REPOSITORY_LOG.ReasonInvalidNormalizedScope,
        orderId: row.id,
        sourceScopeKind: row.source_scope_kind,
        tokenId: row.token_id,
        hasEncodedTokenIds: row.source_encoded_token_ids !== null,
        hasSourceSchemaJson: row.source_schema_json !== null,
    });
    return [];
}

function indexedOrderPlacedAt(row: IndexedOrderRow): string | null {
    return epochSecondsToRfc3339(row.valid_from) ?? row.created_at;
}

function epochSecondsToRfc3339(value: number | null): string | null {
    if (value === null || !Number.isFinite(value) || value <= 0) {
        return null;
    }

    return new Date(Math.floor(value * 1000))
        .toISOString()
        .replace(".000Z", "Z");
}

function resolveIndexedOrderBidScope(
    row: IndexedOrderRow,
): IndexedOrderBidScope | null {
    if (row.source_scope_kind === INDEXED_ORDER_SOURCE_SCOPE_KIND.Token) {
        if (!row.token_id) {
            return null;
        }
        return {
            kind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
            label: formatTradingBiddingBidScopeLabel({
                kind: TRADING_BIDDING_BID_SCOPE_KIND.Token,
                tokenId: row.token_id,
            }),
            tokenId: row.token_id,
            traits: [],
            encodedTokenIds: null,
        };
    }

    if (row.source_scope_kind === INDEXED_ORDER_SOURCE_SCOPE_KIND.Attribute) {
        const traits = parseIndexedOrderTraitCriteria(row.source_schema_json);
        if (traits.length === 0) {
            return null;
        }
        return {
            kind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
            label: formatTradingBiddingBidScopeLabel({
                kind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
                traits,
            }),
            tokenId: null,
            traits,
            encodedTokenIds: row.source_encoded_token_ids,
        };
    }

    if (row.source_scope_kind === INDEXED_ORDER_SOURCE_SCOPE_KIND.Collection) {
        return {
            kind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
            label: formatTradingBiddingBidScopeLabel({
                kind: TRADING_BIDDING_BID_SCOPE_KIND.Collection,
            }),
            tokenId: null,
            traits: [],
            encodedTokenIds: row.source_encoded_token_ids,
        };
    }

    if (row.source_scope_kind === INDEXED_ORDER_SOURCE_SCOPE_KIND.TokenSet) {
        return {
            kind: TRADING_BIDDING_BID_SCOPE_KIND.TokenSet,
            label: formatTradingBiddingBidScopeLabel({
                kind: TRADING_BIDDING_BID_SCOPE_KIND.TokenSet,
            }),
            tokenId: null,
            traits: [],
            encodedTokenIds: row.source_encoded_token_ids,
        };
    }

    return null;
}

function parseIndexedOrderTraitCriteria(
    sourceSchemaJson: string | null,
): TradingTraitCriterion[] {
    if (!sourceSchemaJson) {
        return [];
    }

    try {
        const parsed = JSON.parse(sourceSchemaJson) as unknown;
        return isTokenSetAttributeSchema(parsed)
            ? parsed.data.attributes.map((attribute) => ({
                  type: normalizeTradingTraitText(attribute.key),
                  value: normalizeTradingTraitText(attribute.value),
              }))
            : [];
    } catch {
        return [];
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
    return (
        makerAddress === null ||
        (!isPersistedOwnJobIntentRow(bid) &&
            bid.maker.toLowerCase() === makerAddress)
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

function traitValueWithinRange(
    value: string,
    range: TraitRangeFilter,
): boolean {
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
                    type: normalizeTradingTraitText(record.type),
                    value: normalizeTradingTraitText(record.value),
                },
            ];
        });
    } catch {
        return [];
    }
}

function parseRuntimeBidPosition(
    value: string | null,
): TradingBiddingJobRuntimeBidPosition | null {
    return isTradingBiddingJobRuntimeBidPosition(value) ? value : null;
}

function parseRuntimeBidConstraints(
    value: string | null,
): TradingBiddingJobRuntimeConstraint[] {
    if (!value) {
        return [];
    }

    try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
            return [];
        }
        return parsed.flatMap((entry) =>
            isTradingBiddingJobRuntimeConstraint(entry) ? [entry] : [],
        );
    } catch {
        return [];
    }
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
