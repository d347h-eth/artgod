export {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
} from "@artgod/shared/types/sync-backfill";
import type {
    BackfillOrderMaintenancePolicy,
    BackfillSource,
} from "@artgod/shared/types/sync-backfill";
import type { ReorgResyncIdentity } from "./reorg-recovery.js";
import { BACKFILL_SOURCE } from "@artgod/shared/types/sync-backfill";
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

type BackfillRangePayload = {
    fromBlock: number;
    toBlock: number;
    orderMaintenancePolicy: BackfillOrderMaintenancePolicy;
};

export type ReorgResyncPayload = BackfillRangePayload & {
    source: typeof BACKFILL_SOURCE.ReorgRecovery;
    recovery: ReorgResyncIdentity;
};

export type BackfillSyncPayload =
    | ReorgResyncPayload
    | (BackfillRangePayload & {
          source: Exclude<BackfillSource, typeof BACKFILL_SOURCE.ReorgRecovery>;
      });
