// Capture before RPC work; rollback advances the revision in its write transaction.
export type ChainSyncCheckpoint = { chainId: number; revision: number };

// State reads must identify one block, even when providers disagree at its height.
export type ChainBlockReference = {
    chainId: number;
    blockNumber: number;
    blockHash: string;
};

export type VerifiedChainBlock = SyncBlockHeader & { chainId: number };

export type SyncBlockHeader = {
    number: number;
    hash: string;
    parentHash: string;
    timestamp: number;
};

/** Recent blocks belong to realtime; automatic missing history ends immediately below. */
export function automaticGapUpperBound(
    head: number,
    reorgDepth: number,
): number {
    return Math.max(0, head - reorgDepth);
}

export function realtimeWindowStart(head: number, reorgDepth: number): number {
    return Math.max(1, head - reorgDepth + 1);
}

export class ChainSyncConflict extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ChainSyncConflict";
    }
}
