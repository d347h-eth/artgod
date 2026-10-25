import type { PendingCanonicalCheck } from "./canonical-check.js";

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

/** Durable current-state coverage starts at an explicitly accepted base anchor.
 * Stored headers alone do not establish this applied prefix. */
export type AppliedChainProgress = {
    checkpoint: ChainSyncCheckpoint;
    anchor: SyncBlockHeader;
    applied: SyncBlockHeader;
};

export type CollectionAppliedProgress = AppliedChainProgress & {
    collectionId: number;
};

/** Validation receives one coherent point covered by its collection and shared
 * protocol progress. It cannot select or advance that point itself. */
export type ValidationCheckpoint = ChainSyncCheckpoint & {
    collectionId: number;
    block: SyncBlockHeader;
};

/** Progress beyond the candidate does not invalidate its proof. Only a changed
 * chain revision or an already newer proof can make this position obsolete.
 * Canonical membership, recovery, demand and claim ownership are separate commit
 * guards; this predicate cannot establish them from block heights alone. */
export function canCommitValidationCheckpoint(input: {
    candidate: ValidationCheckpoint;
    current: ChainSyncCheckpoint;
    previous: ValidationCheckpoint | null;
}): boolean {
    const { candidate, current, previous } = input;
    if (
        candidate.chainId !== current.chainId ||
        candidate.revision !== current.revision
    )
        return false;
    if (!previous) return true;
    if (
        previous.chainId !== candidate.chainId ||
        previous.collectionId !== candidate.collectionId ||
        previous.revision > candidate.revision
    )
        return false;
    if (previous.revision < candidate.revision) return true;
    return (
        candidate.block.number > previous.block.number ||
        (candidate.block.number === previous.block.number &&
            candidate.block.hash === previous.block.hash)
    );
}

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
/** A stored header disagreement needs fresh verification after the failed writer exits. */
export class StoredBlockHashConflict extends ChainSyncConflict {
    constructor(
        readonly check: PendingCanonicalCheck,
        readonly observedHash: string,
    ) {
        super(
            `Sync conflicts with stored block ${check.blockNumber}; rollback is required`,
        );
        this.name = "StoredBlockHashConflict";
    }
}
