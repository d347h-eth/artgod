import type { ChainBlockReference } from "./chain-sync.js";
import type { JobEnvelope } from "./jobs.js";

export const SYNC_FOLLOW_UP_KIND = {
    Range: "range",
    Event: "event",
} as const;

// Range jobs read the current persisted facts and remain useful after rollback.
// Event jobs retain ephemeral hints and are valid only on their originating fork.
export type SyncFollowUp =
    | { kind: typeof SYNC_FOLLOW_UP_KIND.Range; job: JobEnvelope }
    | {
          kind: typeof SYNC_FOLLOW_UP_KIND.Event;
          job: JobEnvelope;
          block: ChainBlockReference;
      };

export function eventSyncFollowUp(
    job: JobEnvelope,
    attribution: { blockNumber: number; blockHash: string },
): SyncFollowUp {
    return {
        kind: SYNC_FOLLOW_UP_KIND.Event,
        job,
        block: {
            chainId: job.chainId,
            blockNumber: attribution.blockNumber,
            blockHash: attribution.blockHash,
        },
    };
}
