export const DOMAIN_JOB_KIND = {
    OrdersSync: "domain.orders.sync",
    MetadataSync: "domain.metadata.sync",
    MetadataRefresh: "domain.metadata.refresh",
    MetadataRefreshRange: "domain.metadata.refresh-range",
    MetadataStatsRecompute: "domain.metadata.stats-recompute",
    ActivitySync: "domain.activity.sync",
} as const;

export type DomainSyncMode = "realtime" | "backfill";

// This tells domains whether a sync may update current state.
export const DOMAIN_SYNC_PROJECTION = {
    FactsOnly: "facts_only",
    CurrentState: "current_state",
} as const;

export type DomainSyncProjection =
    (typeof DOMAIN_SYNC_PROJECTION)[keyof typeof DOMAIN_SYNC_PROJECTION];

export type DomainSyncPayload = {
    fromBlock: number;
    toBlock: number;
    mode: DomainSyncMode;
    // This says whether the range is facts-only or current-state.
    projection: DomainSyncProjection;
    sourceJobId: string;
    sourceKind: string;
};

export type MetadataRefreshPayload = {
    chainId: number;
    collectionId: number;
    tokenId: string;
    standard?: "erc721" | "erc1155";
    metadataUrl?: string | null;
    blockNumber?: number;
    blockHash?: string;
    blockTimestamp?: number;
    reason: string;
    source?: string | null;
};

export type MetadataRefreshRangePayload = {
    chainId: number;
    collectionId: number;
    fromTokenId: string;
    toTokenId: string;
    cursorTokenId: string;
    reason: string;
    source?: string | null;
};

export type MetadataStatsRecomputePayload = {
    chainId: number;
    collectionId: number;
    reason:
        | "metadata-sync"
        | "metadata-refresh"
        | "bootstrap-finalized"
        | "reorg-resync";
    sourceJobId?: string | null;
};
