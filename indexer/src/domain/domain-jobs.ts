export const DOMAIN_JOB_KIND = {
    OrdersSync: "domain.orders.sync",
    MetadataSync: "domain.metadata.sync",
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
