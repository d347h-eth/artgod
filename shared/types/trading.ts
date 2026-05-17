export const TRADING_BOT_KIND = {
    Bidding: "bidding",
    Sniping: "sniping",
} as const;

export type TradingBotKind =
    (typeof TRADING_BOT_KIND)[keyof typeof TRADING_BOT_KIND];

export const TRADING_BOT_RUNTIME_STATE = {
    Bootstrapping: "bootstrapping",
    Running: "running",
    Stopped: "stopped",
    Error: "error",
} as const;

export type TradingBotRuntimeState =
    (typeof TRADING_BOT_RUNTIME_STATE)[keyof typeof TRADING_BOT_RUNTIME_STATE];

export const TRADING_JOB_STATUS = {
    Enabled: "enabled",
    Paused: "paused",
    Archived: "archived",
} as const;

export type TradingJobStatus =
    (typeof TRADING_JOB_STATUS)[keyof typeof TRADING_JOB_STATUS];

export const TRADING_JOB_TARGET_KIND = {
    Token: "token",
    Collection: "collection",
    CompetitiveTrait: "competitive_trait",
} as const;

export type TradingJobTargetKind =
    (typeof TRADING_JOB_TARGET_KIND)[keyof typeof TRADING_JOB_TARGET_KIND];

export const TRADING_JOB_COMMAND_KIND = {
    JobCreated: "job_created",
    JobUpdated: "job_updated",
    JobPaused: "job_paused",
    JobArchived: "job_archived",
    CancelActiveOffer: "cancel_active_offer",
} as const;

export type TradingJobCommandKind =
    (typeof TRADING_JOB_COMMAND_KIND)[keyof typeof TRADING_JOB_COMMAND_KIND];

export const TRADING_JOB_COMMAND_STATUS = {
    Pending: "pending",
    Processing: "processing",
    Completed: "completed",
    FailedRetry: "failed_retry",
    FailedTerminal: "failed_terminal",
} as const;

export type TradingJobCommandStatus =
    (typeof TRADING_JOB_COMMAND_STATUS)[keyof typeof TRADING_JOB_COMMAND_STATUS];

export const TRADING_JOB_SIGNAL_KIND = {
    BiddingJobsChanged: "bidding_jobs_changed",
} as const;

export type TradingJobSignalKind =
    (typeof TRADING_JOB_SIGNAL_KIND)[keyof typeof TRADING_JOB_SIGNAL_KIND];

export const TRADING_JOB_SIGNAL_STREAM_SUFFIX = "trading-signals";

export const TRADING_JOB_SIGNAL_SUBJECT = {
    BiddingJobsChanged: "trading.bidding.jobs.changed",
} as const;

export type TradingBiddingJobsChangedSignal = {
    kind: typeof TRADING_JOB_SIGNAL_KIND.BiddingJobsChanged;
    commandIds: number[];
    jobIds: string[];
    publishedAt: string;
};

// Builds the shared JetStream stream name for trading command wake-up signals.
export function tradingJobSignalStreamName(streamPrefix: string): string {
    return `${streamPrefix}-${TRADING_JOB_SIGNAL_STREAM_SUFFIX}`;
}

// Builds the shared subject for bidding job command wake-up signals.
export function tradingBiddingJobsChangedSubject(streamPrefix: string): string {
    return `${streamPrefix}.${TRADING_JOB_SIGNAL_SUBJECT.BiddingJobsChanged}`;
}

export type TradingTraitCriterion = {
    type: string;
    value: string;
};

export type TradingBiddingJobTargetDescriptor =
    | {
          targetKind: typeof TRADING_JOB_TARGET_KIND.Token;
          tokenId: string;
      }
    | {
          targetKind: typeof TRADING_JOB_TARGET_KIND.Collection;
          quantity: number;
          targetTraits: TradingTraitCriterion[];
      }
    | {
          targetKind: typeof TRADING_JOB_TARGET_KIND.CompetitiveTrait;
          quantity: number;
          targetTraits: TradingTraitCriterion[];
          competitorTraits: TradingTraitCriterion[];
      };

// Normalizes trait criteria before target comparison or persistence.
export function normalizeTradingTraitCriteria(
    traits: TradingTraitCriterion[],
): TradingTraitCriterion[] {
    return [...traits]
        .map((trait) => ({
            type: trait.type.trim(),
            value: trait.value.trim(),
        }))
        .sort(compareTradingTraitCriteria);
}

// Builds a stable key for comparing unordered trait criteria.
export function tradingTraitCriteriaKey(
    traits: TradingTraitCriterion[],
): string {
    return normalizeTradingTraitCriteria(traits)
        .map((trait) => `${trait.type}\u0000${trait.value}`)
        .join("\u0001");
}

// Builds the canonical identity key for one declared bidding target.
export function tradingBiddingJobTargetKey(
    target: TradingBiddingJobTargetDescriptor,
): string {
    if (target.targetKind === TRADING_JOB_TARGET_KIND.Token) {
        return `${target.targetKind}\u0002${target.tokenId.trim()}`;
    }

    if (target.targetKind === TRADING_JOB_TARGET_KIND.Collection) {
        return [
            target.targetKind,
            String(target.quantity),
            tradingTraitCriteriaKey(target.targetTraits),
        ].join("\u0002");
    }

    return [
        target.targetKind,
        String(target.quantity),
        tradingTraitCriteriaKey(target.targetTraits),
        tradingTraitCriteriaKey(target.competitorTraits),
    ].join("\u0002");
}

function compareTradingTraitCriteria(
    left: TradingTraitCriterion,
    right: TradingTraitCriterion,
): number {
    const typeCompare = left.type.localeCompare(right.type);
    return typeCompare === 0
        ? left.value.localeCompare(right.value)
        : typeCompare;
}

// Reuses the enabled/paused/archived lifecycle for collection bidding price tiers.
export type TradingBiddingPriceTierStatus = TradingJobStatus;

export const TRADING_BIDDING_PRICE_TIER_DELTA_KIND = {
    Absolute: "absolute",
    Percent: "percent",
} as const;

export type TradingBiddingPriceTierDeltaKind =
    (typeof TRADING_BIDDING_PRICE_TIER_DELTA_KIND)[keyof typeof TRADING_BIDDING_PRICE_TIER_DELTA_KIND];

export const TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND = {
    Fixed: "fixed",
    ParentDelta: "parent_delta",
} as const;

export type TradingBiddingPriceTierFloorConfigKind =
    (typeof TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND)[keyof typeof TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND];

export const TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND = {
    Fixed: "fixed",
    FloorDelta: "floor_delta",
    ParentDelta: "parent_delta",
} as const;

export type TradingBiddingPriceTierCeilingConfigKind =
    (typeof TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND)[keyof typeof TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND];

// Default fixed bid increment used when a collection has not customized bidding settings yet.
export const DEFAULT_TRADING_BIDDING_PRICE_DELTA_ETH = "0.001";
export const DEFAULT_TRADING_BIDDING_PRICE_DELTA_WEI = "1000000000000000";

// Selects how price tiers are presented in the bidding automation form.
export const TRADING_BIDDING_TIER_SELECTION_MODE = {
    Buttons: "buttons",
    Dropdown: "dropdown",
} as const;

export type TradingBiddingTierSelectionMode =
    (typeof TRADING_BIDDING_TIER_SELECTION_MODE)[keyof typeof TRADING_BIDDING_TIER_SELECTION_MODE];

// Names bidding-owned entries stored in the generic collection settings table.
export const TRADING_BIDDING_COLLECTION_SETTING_KEY = {
    TierSelectionMode: "trading.bidding.tier_selection_mode",
    DefaultDeltaWei: "trading.bidding.default_delta_wei",
} as const;

export type TradingBiddingCollectionSettingKey =
    (typeof TRADING_BIDDING_COLLECTION_SETTING_KEY)[keyof typeof TRADING_BIDDING_COLLECTION_SETTING_KEY];

// Stores the original human-entered floor rule for a collection bidding tier.
export type TradingBiddingPriceTierFloorConfig =
    | {
          kind: typeof TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed;
          valueEth: string;
      }
    | {
          kind: typeof TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.ParentDelta;
          deltaKind: TradingBiddingPriceTierDeltaKind;
          deltaEth?: string;
          percent?: string;
      };

// Stores the original human-entered ceiling rule for a collection bidding tier.
export type TradingBiddingPriceTierCeilingConfig =
    | {
          kind: typeof TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed;
          valueEth: string;
      }
    | {
          kind:
              | typeof TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.FloorDelta
              | typeof TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.ParentDelta;
          deltaKind: TradingBiddingPriceTierDeltaKind;
          deltaEth?: string;
          percent?: string;
      };

// Persisted price tier plus its latest resolved scalar values.
export type PersistedBiddingPriceTierRecord = {
    tierId: string;
    chainId: number;
    collectionId: number;
    name: string;
    status: TradingBiddingPriceTierStatus;
    sortOrder: number;
    parentTierId: string | null;
    floorConfig: TradingBiddingPriceTierFloorConfig;
    ceilingConfig: TradingBiddingPriceTierCeilingConfig;
    deltaWei: string;
    resolvedFloorWei: string | null;
    resolvedCeilingWei: string | null;
    resolvedAt: string | null;
    lastError: string | null;
    revision: number;
    createdAt: string;
    updatedAt: string;
    archivedAt: string | null;
};

// Domain view of collection-scoped bidding UI defaults that feed tier and job drafting flows.
export type TradingBiddingCollectionSettingsRecord = {
    chainId: number;
    collectionId: number;
    tierSelectionMode: TradingBiddingTierSelectionMode;
    defaultDeltaWei: string;
    createdAt: string;
    updatedAt: string;
};

export const TRADING_BIDDING_JOB_PRICING_SOURCE_KIND = {
    Manual: "manual",
    PriceTier: "price_tier",
} as const;

export type TradingBiddingJobPricingSourceKind =
    (typeof TRADING_BIDDING_JOB_PRICING_SOURCE_KIND)[keyof typeof TRADING_BIDDING_JOB_PRICING_SOURCE_KIND];

// Explains how the bot-facing scalar bidding prices were resolved at submit time.
export type TradingBiddingJobPricingSource =
    | {
          kind: typeof TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.Manual;
      }
    | {
          kind: typeof TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier;
          tierId: string;
          tierName: string;
          resolvedAt: string | null;
          resolvedFloorWei: string;
          resolvedCeilingWei: string;
          deltaWei: string;
      };

// Names collection bid-book scope filters used by backend API and frontend navigation.
export const COLLECTION_BIDDING_BID_SCOPE_FILTER = {
    Token: "token",
    Traits: "traits",
    Collection: "collection",
} as const;

export type CollectionBiddingBidScopeFilter =
    (typeof COLLECTION_BIDDING_BID_SCOPE_FILTER)[keyof typeof COLLECTION_BIDDING_BID_SCOPE_FILTER];

// Orders bid-book scope filters for stable segmented-control cycling.
export const COLLECTION_BIDDING_BID_SCOPE_FILTERS = [
    COLLECTION_BIDDING_BID_SCOPE_FILTER.Token,
    COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
    COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection,
] as const;

// Names trait-filter join modes supported by collection bidding views.
export const COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE = {
    Or: "or",
    And: "and",
} as const;

export type CollectionBiddingTraitFilterJoinMode =
    (typeof COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE)[keyof typeof COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE];

// Lists trait-filter join modes for validation at transport boundaries.
export const COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODES = [
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or,
    COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
] as const;

// Names collection bidding view modes used by frontend navigation.
export const COLLECTION_BIDDING_VIEW_MODE = {
    BidBook: "bid_book",
    Jobs: "jobs",
} as const;

export type CollectionBiddingViewMode =
    (typeof COLLECTION_BIDDING_VIEW_MODE)[keyof typeof COLLECTION_BIDDING_VIEW_MODE];

// Orders bidding view modes for stable frontend query parsing.
export const COLLECTION_BIDDING_VIEW_MODES = [
    COLLECTION_BIDDING_VIEW_MODE.BidBook,
    COLLECTION_BIDDING_VIEW_MODE.Jobs,
] as const;

// Names bid-book query parameters shared by frontend links and backend handlers.
export const COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS = {
    BidScope: "bid_scope",
    TraitJoin: "trait_join",
    Maker: "maker",
    ShowMuted: "show_muted",
} as const;

// Names collection bidding view query parameters.
export const COLLECTION_BIDDING_VIEW_QUERY_PARAMS = {
    View: "bidding_view",
} as const;

export const TRADING_BIDDING_BID_BOOK_SOURCE = {
    BotSnapshot: "bot_snapshot",
    Orders: "orders",
} as const;

export type TradingBiddingBidBookSource =
    (typeof TRADING_BIDDING_BID_BOOK_SOURCE)[keyof typeof TRADING_BIDDING_BID_BOOK_SOURCE];

// Distinguishes real marketplace rows from local job-intent rows rendered in admin bid books.
export const TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND = {
    MarketBid: "market_bid",
    OwnJobIntent: "own_job_intent",
} as const;

export type TradingBiddingBidBookRowMaterializationKind =
    (typeof TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND)[keyof typeof TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND];

// Explains which local job/runtime phase produced an own-intent bid-book row.
export const TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE = {
    Queued: "queued",
    ActiveOrder: "active_order",
    Paused: "paused",
} as const;

export type TradingBiddingBidBookOwnJobPhase =
    (typeof TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE)[keyof typeof TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE];

// Identifies whether a bid-book row has one market price or a configured job price range.
export const TRADING_BIDDING_BID_BOOK_PRICE_KIND = {
    Exact: "exact",
    Range: "range",
} as const;

export type TradingBiddingBidBookPriceKind =
    (typeof TRADING_BIDDING_BID_BOOK_PRICE_KIND)[keyof typeof TRADING_BIDDING_BID_BOOK_PRICE_KIND];

export const TRADING_BIDDING_BID_SCOPE_KIND = {
    Collection: "collection",
    Trait: "trait",
    Token: "token",
    TokenSet: "token_set",
    Unknown: "unknown",
} as const;

export type TradingBiddingBidScopeKind =
    (typeof TRADING_BIDDING_BID_SCOPE_KIND)[keyof typeof TRADING_BIDDING_BID_SCOPE_KIND];

export type PersistedBiddingJobRuntimeState = {
    currentPriceWei: string | null;
    activeOrderId: string | null;
    activeProtocolAddress: string | null;
    activeExpirationTimeMs: number | null;
    lastRunAt: string | null;
    lastError: string | null;
    cancellationRequestedAt: string | null;
    cancellationCompletedAt: string | null;
    cancellationError: string | null;
    updatedAt: string;
};

type PersistedBiddingJobBase = {
    jobId: string;
    botKind: typeof TRADING_BOT_KIND.Bidding;
    chainId: number;
    collectionId: number;
    collectionSlug: string;
    collectionOpenseaSlug: string | null;
    collectionAddress: string;
    status: TradingJobStatus;
    floorWei: string;
    ceilingWei: string;
    deltaWei: string;
    priceTierId: string | null;
    pricingSource: TradingBiddingJobPricingSource | null;
    revision: number;
    createdAt: string;
    updatedAt: string;
    archivedAt: string | null;
    runtime: PersistedBiddingJobRuntimeState | null;
};

export type PersistedTokenBiddingJobRecord = PersistedBiddingJobBase & {
    targetKind: typeof TRADING_JOB_TARGET_KIND.Token;
    tokenId: string;
    quantity: null;
    targetTraits: [];
    competitorTraits: [];
};

export type PersistedCollectionBiddingJobRecord = PersistedBiddingJobBase & {
    targetKind: typeof TRADING_JOB_TARGET_KIND.Collection;
    tokenId: null;
    quantity: number;
    targetTraits: TradingTraitCriterion[];
    competitorTraits: [];
};

export type PersistedCompetitiveTraitBiddingJobRecord =
    PersistedBiddingJobBase & {
        targetKind: typeof TRADING_JOB_TARGET_KIND.CompetitiveTrait;
        tokenId: null;
        quantity: number;
        targetTraits: TradingTraitCriterion[];
        competitorTraits: TradingTraitCriterion[];
    };

export type PersistedBiddingJobRecord =
    | PersistedTokenBiddingJobRecord
    | PersistedCollectionBiddingJobRecord
    | PersistedCompetitiveTraitBiddingJobRecord;

export type TradingJobCommandRecord = {
    commandId: number;
    jobId: string;
    botKind: TradingBotKind;
    commandKind: TradingJobCommandKind;
    status: TradingJobCommandStatus;
    requestedRevision: number;
    payload: Record<string, unknown>;
    attempts: number;
    lastError: string | null;
    createdAt: string;
    claimedAt: string | null;
    completedAt: string | null;
};
