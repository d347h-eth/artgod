export const SYNC_JOB_KIND = {
    RealtimeBlock: "sync.realtime.block",
    BackfillRange: "sync.backfill.range",
} as const;

export type RealtimeSyncPayload = {
    blockNumber: number;
};

export type BackfillSyncPayload = {
    fromBlock: number;
    toBlock: number;
};
