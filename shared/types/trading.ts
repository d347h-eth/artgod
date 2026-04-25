export const TRADING_BOT_KIND = {
    Bidding: "bidding",
    Sniping: "sniping",
} as const;

export type TradingBotKind =
    (typeof TRADING_BOT_KIND)[keyof typeof TRADING_BOT_KIND];

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
