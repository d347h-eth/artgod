// Backfill plan kinds are persisted into logs/events by the bootstrap worker.
export const BOOTSTRAP_BACKFILL_PLAN_KIND = {
    NoPostAnchorBlocks: "no_post_anchor_blocks",
    QueueBackfill: "queue_backfill",
} as const;

export type BootstrapBackfillPlanKind =
    (typeof BOOTSTRAP_BACKFILL_PLAN_KIND)[keyof typeof BOOTSTRAP_BACKFILL_PLAN_KIND];

export type BootstrapBackfillPlan =
    | {
          kind: typeof BOOTSTRAP_BACKFILL_PLAN_KIND.NoPostAnchorBlocks;
          fromBlock: number;
          headBlock: number;
      }
    | {
          kind: typeof BOOTSTRAP_BACKFILL_PLAN_KIND.QueueBackfill;
          fromBlock: number;
          toBlock: number;
          totalBlocks: number;
      };

// Resolves whether bootstrap should finish live immediately or queue post-anchor catch-up.
export function resolveBootstrapBackfillPlan(input: {
    fromBlock: number;
    headBlock: number;
}): BootstrapBackfillPlan {
    if (input.headBlock < input.fromBlock) {
        return {
            kind: BOOTSTRAP_BACKFILL_PLAN_KIND.NoPostAnchorBlocks,
            fromBlock: input.fromBlock,
            headBlock: input.headBlock,
        };
    }

    return {
        kind: BOOTSTRAP_BACKFILL_PLAN_KIND.QueueBackfill,
        fromBlock: input.fromBlock,
        toBlock: input.headBlock,
        totalBlocks: input.headBlock - input.fromBlock + 1,
    };
}
