import type { CollectionRecord } from "../domain/collections.js";
import type { SyncRange } from "./sync.js";

// Backfill execution mode controls whether a queued range may run in parallel.
export const BACKFILL_EXECUTION_MODE = {
    ParallelFactsOnly: "parallel_facts_only",
    SerializedCurrentState: "serialized_current_state",
} as const;

export type BackfillExecutionMode =
    (typeof BACKFILL_EXECUTION_MODE)[keyof typeof BACKFILL_EXECUTION_MODE];

// A range can run in parallel only when every affected collection is pre-anchor.
export function resolveBackfillExecutionMode(
    collections: CollectionRecord[],
    range: SyncRange,
): BackfillExecutionMode {
    if (collections.length === 0) {
        return BACKFILL_EXECUTION_MODE.ParallelFactsOnly;
    }
    const isFactsOnly = collections.every((collection) =>
        collection.isRangeAtOrBeforeBootstrapAnchor(
            range.fromBlock,
            range.toBlock,
        ),
    );
    return isFactsOnly
        ? BACKFILL_EXECUTION_MODE.ParallelFactsOnly
        : BACKFILL_EXECUTION_MODE.SerializedCurrentState;
}

// Serializes current-state-capable backfills without slowing pre-anchor facts-only ranges.
export class BackfillExecutionGate {
    private currentStateTail: Promise<void> = Promise.resolve();

    async run<T>(
        mode: BackfillExecutionMode,
        task: () => Promise<T>,
    ): Promise<T> {
        if (mode === BACKFILL_EXECUTION_MODE.ParallelFactsOnly) {
            return task();
        }

        return this.runSerialized(task);
    }

    private runSerialized<T>(task: () => Promise<T>): Promise<T> {
        const previous = this.currentStateTail;
        const next = previous.then(task, task);
        this.currentStateTail = next.then(
            () => undefined,
            () => undefined,
        );
        return next;
    }
}
