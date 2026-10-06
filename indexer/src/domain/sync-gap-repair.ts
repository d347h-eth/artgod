import type { SyncGapRepairTarget } from "./sync-jobs.js";

export type SyncGapRepairBatch = {
    fromBlock: number;
    toBlock: number;
    repairs: SyncGapRepairTarget[];
};

// Group overlapping intents from newest to oldest. Every member's covered part
// is a suffix, so its unfinished intent remains one contiguous older range.
// A batch may also read already covered blocks for its participating collections.
export function planSyncGapRepairBatches(
    repairs: readonly SyncGapRepairTarget[],
    batchSize: number,
): SyncGapRepairBatch[] {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1)
        throw new RangeError(
            "Gap repair batch size must be a positive safe integer",
        );
    const pending = [...repairs].sort(
        (a, b) => b.toBlock - a.toBlock || a.collectionId - b.collectionId,
    );
    const batches: SyncGapRepairBatch[] = [];
    while (pending.length) {
        const first = pending.shift()!;
        const lowerBound = first.toBlock - batchSize + 1;
        let fromBlock = Math.max(first.fromBlock, lowerBound);
        const members = [first];
        while (pending.length && pending[0].toBlock >= fromBlock) {
            const next = pending.shift()!;
            members.push(next);
            fromBlock = Math.max(
                lowerBound,
                Math.min(fromBlock, next.fromBlock),
            );
        }
        batches.push({
            fromBlock,
            toBlock: first.toBlock,
            repairs: members.sort((a, b) => a.collectionId - b.collectionId),
        });
    }
    return batches;
}

export function remainingSyncGapRepairRange(
    repair: SyncGapRepairTarget,
    repairedFromBlock: number,
): { fromBlock: number; toBlock: number } | null {
    return repairedFromBlock > repair.fromBlock
        ? { fromBlock: repair.fromBlock, toBlock: repairedFromBlock - 1 }
        : null;
}
