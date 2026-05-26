export {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
} from "@artgod/shared/types/sync-backfill";
import type {
    BackfillOrderMaintenancePolicy,
    BackfillSource,
} from "@artgod/shared/types/sync-backfill";
export type {
    BackfillOrderMaintenancePolicy,
    BackfillSource,
} from "@artgod/shared/types/sync-backfill";

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
    source: BackfillSource;
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy;
};
