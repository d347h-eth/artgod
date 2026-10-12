import {
    ChainSyncConflict,
    type ChainSyncCheckpoint,
    type SyncBlockHeader,
    type VerifiedChainBlock,
} from "./chain-sync.js";
import { assertSyncBlockHeaders } from "./sync-result.js";

// Capture the complete bounded local window, including missing heights, before
// RPC. Newly filled holes must invalidate this evidence at rollback commit.
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

// Sparse repair can insert a canonical header above an older orphan. A match is
// an ancestor only below every divergence in the bounded local history. Stored
// parent identities also reveal divergence at a height whose header is missing.
export function proveReorgAncestor(input: {
    history: ReorgHistorySnapshot;
    canonicalBlocks: readonly SyncBlockHeader[];
}): ReorgAncestorProof | null {
    const { history, canonicalBlocks } = input;
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
