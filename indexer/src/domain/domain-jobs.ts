export const DOMAIN_JOB_KIND = {
    OrdersSync: "domain.orders.sync",
    MetadataSync: "domain.metadata.sync",
    MetadataRefresh: "domain.metadata.refresh",
    MetadataRefreshRange: "domain.metadata.refresh-range",
    MetadataStatsRecompute: "domain.metadata.stats-recompute",
    ActivitySync: "domain.activity.sync",
} as const;

export type DomainSyncMode = "realtime" | "backfill";

export type DomainSyncPayload = {
    fromBlock: number;
    toBlock: number;
    mode: DomainSyncMode;
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
