import {
    ChainSyncConflict,
    type ChainSyncCheckpoint,
    type SyncBlockHeader,
    type VerifiedChainBlock,
} from "./chain-sync.js";
import { assertSyncBlockHeaders } from "./sync-result.js";

// Capture a complete connected window of already accepted lineage before RPC.
// Missing local ancestry is an unready view, never an invitation to guess.
export type ReorgHistorySnapshot = {
    checkpoint: ChainSyncCheckpoint;
    fromBlock: number;
    toBlock: number;
    headers: readonly SyncBlockHeader[];
};

export type ReorgAncestorProof = {
    fork: VerifiedChainBlock;
    history: ReorgHistorySnapshot;
};

export function assertReorgHistory(history: ReorgHistorySnapshot): void {
    if (
        !Number.isSafeInteger(history.fromBlock) ||
        history.fromBlock < 0 ||
        !Number.isSafeInteger(history.toBlock) ||
        history.toBlock < history.fromBlock ||
        history.headers.length !== history.toBlock - history.fromBlock + 1 ||
        history.headers.some(
            (block, index) => block.number !== history.fromBlock + index,
        )
    )
        throw new ChainSyncConflict("Incomplete accepted ancestor window");
    assertSyncBlockHeaders(history.headers);
}

// A match is an ancestor only below every divergence within the supported
// accepted window. Neither replacement RPC nor historical import fills holes
// in old-branch evidence that the chain owner should already have retained.
export function proveReorgAncestor(input: {
    history: ReorgHistorySnapshot;
    canonicalBlocks: readonly SyncBlockHeader[];
}): ReorgAncestorProof | null {
    const { history, canonicalBlocks } = input;
    assertReorgHistory(history);
    assertSyncBlockHeaders(canonicalBlocks);
    if (
        canonicalBlocks.length !== history.toBlock - history.fromBlock + 1 ||
        canonicalBlocks.some(
            (block, index) => block.number !== history.fromBlock + index,
        )
    )
        throw new ChainSyncConflict("Incomplete canonical ancestor window");
    const canonical = new Map(
        canonicalBlocks.map((block) => [block.number, block]),
    );
    let firstDivergence = history.toBlock;
    for (const stored of history.headers) {
        const current = canonical.get(stored.number);
        if (!current)
            throw new ChainSyncConflict(
                "Stored header is outside the ancestor window",
            );
        if (
            stored.hash !== current.hash ||
            stored.timestamp !== current.timestamp
        )
            firstDivergence = Math.min(firstDivergence, stored.number);
        if (stored.number > 0 && stored.parentHash !== current.parentHash)
            firstDivergence = Math.min(firstDivergence, stored.number - 1);
    }
    let fork: SyncBlockHeader | undefined;
    for (const stored of history.headers) {
        const current = canonical.get(stored.number)!;
        if (
            stored.number < firstDivergence &&
            stored.hash === current.hash &&
            stored.parentHash === current.parentHash &&
            stored.timestamp === current.timestamp &&
            (!fork || stored.number > fork.number)
        )
            fork = current;
    }
    return fork
        ? { fork: { ...fork, chainId: history.checkpoint.chainId }, history }
        : null;
}
