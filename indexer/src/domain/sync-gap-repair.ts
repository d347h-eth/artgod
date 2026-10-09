import type { CollectionRecord } from "./collections.js";

export type SyncGapRange = { fromBlock: number; toBlock: number };
export type PendingSyncGapRepair = SyncGapRange & {
    repairId: string;
    retryAt: number;
};
export type SyncGapProgress = {
    anchorBlock: number;
    cursorBlock: number | null;
    pending: PendingSyncGapRepair | null;
    // Epoch milliseconds; null means no HEAD check has been recorded yet.
    lastHeadCheckAt: number | null;
};
export type SyncGapRepairTarget = SyncGapRange & {
    collectionId: number;
    repairId: string;
    anchorBlock: number;
};

export type SyncGapRepairCursor = { retryAt: number; collectionId: number };
export type SyncGapRepairPage = {
    repairs: SyncGapRepairTarget[];
    cursor: SyncGapRepairCursor | null;
};

export function isCurrentSyncGapRepair(input: {
    chainId: number;
    repair: SyncGapRepairTarget;
    collection: CollectionRecord | null;
    progress: SyncGapProgress | null;
}): boolean {
    const { chainId, repair, collection, progress } = input;
    if (!collection || chainId !== collection.chainId) return false;
    const window = collection.gapRepairWindow(repair.toBlock);
    return (
        !!window &&
        repair.anchorBlock === window.fromBlock &&
        repair.fromBlock >= window.fromBlock &&
        progress?.anchorBlock === window.fromBlock &&
        progress.pending?.repairId === repair.repairId &&
        progress.pending.fromBlock === repair.fromBlock &&
        progress.pending.toBlock === repair.toBlock
    );
}

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
