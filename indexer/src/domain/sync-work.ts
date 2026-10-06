import type { ReorgResyncRange } from "./reorg-recovery.js";
import type { SyncGapRepairBatch } from "./sync-gap-repair.js";

export const SYNC_WORK_COMPLETION = {
    Unmanaged: "unmanaged",
    GapRepair: "gap_repair",
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
