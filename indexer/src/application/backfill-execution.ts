import {
    SYNC_WORK_CLASS,
    type SyncWorkClass,
} from "@artgod/shared/types/sync-work-class";
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
    private active = false;
    private readonly waiting: Array<{
        workClass: SyncWorkClass;
        start: () => void;
    }> = [];

    run<T>(
        mode: BackfillExecutionMode,
        task: () => Promise<T>,
        workClass: SyncWorkClass = SYNC_WORK_CLASS.Main,
    ): Promise<T> {
        if (mode === BACKFILL_EXECUTION_MODE.ParallelFactsOnly) return task();
        return new Promise<T>((resolve, reject) => {
            this.waiting.push({
                workClass,
                start: () => {
                    this.active = true;
                    Promise.resolve()
                        .then(task)
                        .then(resolve, reject)
                        .finally(() => {
                            this.active = false;
                            this.startNext();
                        });
                },
            });
            this.startNext();
        });
    }

    private startNext(): void {
        if (this.active) return;
        // Finish the current bounded range, then admit queued manual/recovery
        // work before another automatic gap range. FIFO within each class.
        const main = this.waiting.findIndex(
            (task) => task.workClass === SYNC_WORK_CLASS.Main,
        );
        const next = this.waiting.splice(main < 0 ? 0 : main, 1)[0];
        next?.start();
    }
}
