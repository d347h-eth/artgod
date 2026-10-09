import { SYNC_WORK_CLASS } from "@artgod/shared/types/sync-work-class";
import type { ReorgResyncRange } from "./reorg-recovery.js";
import type { SyncGapRepairBatch } from "./sync-gap-repair.js";

export const SYNC_WORK_COMPLETION = {
    Unmanaged: "unmanaged",
    GapRepair: SYNC_WORK_CLASS.GapRepair,
    ReorgResync: "reorg_resync",
} as const;

// Acquisition completion is atomic with data and required publication intent.
// The publication outbox remains responsible until the broker accepts each job.
export type SyncWorkCompletion =
    | { kind: typeof SYNC_WORK_COMPLETION.Unmanaged }
    | {
          kind: typeof SYNC_WORK_COMPLETION.GapRepair;
          batch: SyncGapRepairBatch;
          retryAt: number;
      }
    | {
          kind: typeof SYNC_WORK_COMPLETION.ReorgResync;
          range: ReorgResyncRange;
          batchSize: number;
          retryAt: number;
      };

// Background retries survive quota deferrals; broker delivery counts are not
// evidence of actual failures. Pace failed descendants like retained gap ranges.
export const AUTOMATIC_GAP_WORK_POLICY = {
    RetryDelayMs: 5 * 60_000,
    LeaseRenewMaxMs: 10_000,
} as const;
