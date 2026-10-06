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

// A batch carries the retained intent for each member, independently of its
// broker identity. Bounds fence deliveries after a partially completed repair.
export type SyncGapRepairTarget = {
    collectionId: number;
    repairId: string;
    anchorBlock: number;
    fromBlock: number;
    toBlock: number;
};

export type GapRepairSyncPayload = BackfillRangePayload & {
    source: typeof BACKFILL_SOURCE.GapRepair;
    // Optional only to consume collection-scoped deliveries from older runtimes.
    repairs?: SyncGapRepairTarget[];
};

export type BackfillSyncPayload =
    | ReorgResyncPayload
    | GapRepairSyncPayload
    | (BackfillRangePayload & {
          source: Exclude<
              BackfillSource,
              | typeof BACKFILL_SOURCE.ReorgRecovery
              | typeof BACKFILL_SOURCE.GapRepair
          >;
      });
