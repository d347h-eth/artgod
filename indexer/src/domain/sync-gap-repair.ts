import type { SyncGapRepairTarget } from "./sync-jobs.js";

export type SyncGapRepairBatch = {
    fromBlock: number;
    toBlock: number;
    repairs: SyncGapRepairTarget[];
};

// Only share a suffix that is inside every retained intent. Equal upper bounds
// keep each unfinished intent contiguous; unequal starts leave older remainders.
// Widening to the union would reacquire already covered participants' receipts.
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
        while (pending.length && pending[0].toBlock === first.toBlock) {
            const next = pending.shift()!;
            members.push(next);
            fromBlock = Math.max(fromBlock, next.fromBlock);
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
