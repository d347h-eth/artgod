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
    resolvedFloorWei: string | null;
    resolvedCeilingWei: string | null;
    resolvedAt: string | null;
    lastError: string | null;
    revision: number;
    createdAt: string;
    updatedAt: string;
    archivedAt: string | null;
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

export const TRADING_BIDDING_BID_BOOK_SOURCE = {
    BotSnapshot: "bot_snapshot",
    Orders: "orders",
} as const;

export type TradingBiddingBidBookSource =
    (typeof TRADING_BIDDING_BID_BOOK_SOURCE)[keyof typeof TRADING_BIDDING_BID_BOOK_SOURCE];

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
