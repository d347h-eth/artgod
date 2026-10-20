import { SYNC_WORK_CLASS } from "@artgod/shared/types/sync-work-class";
import type { ReorgResyncRange } from "./reorg-recovery.js";
import type { SyncGapRepairBatch } from "./sync-gap-repair.js";
import type {
    AppliedChainProgress,
    CollectionAppliedProgress,
} from "./chain-sync.js";

export const SYNC_APPLICATION_KIND = {
    Historical: "historical",
    Applied: "applied",
} as const;

/** Acquisition carries the exact prefix it intends to extend. Collection-only
 * catch-up can connect an older installed base to accepted shared history, but
 * cannot advance shared progress or validate before reaching the shared base. */
export type SyncApplication =
    | { kind: typeof SYNC_APPLICATION_KIND.Historical }
    | {
          kind: typeof SYNC_APPLICATION_KIND.Applied;
          chain: AppliedChainProgress | null;
          collections: readonly CollectionAppliedProgress[];
      };

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
