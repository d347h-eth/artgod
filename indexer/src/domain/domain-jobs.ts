export const DOMAIN_JOB_KIND = {
    OrdersSync: "domain.orders.sync",
    MetadataSync: "domain.metadata.sync",
    MetadataRefresh: "domain.metadata.refresh",
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
    contract: string;
    tokenId: string;
    metadataUrl?: string | null;
    reason: string;
    source?: string | null;
};
