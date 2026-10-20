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

export const REORG_HISTORY_PROOF = {
    Ancestor: "ancestor",
    RestoredAgreement: "restored_agreement",
} as const;

export type ReorgAncestorProof = {
    kind: typeof REORG_HISTORY_PROOF.Ancestor;
    fork: VerifiedChainBlock;
    history: ReorgHistorySnapshot;
};

export type ReorgRestoredAgreement = {
    kind: typeof REORG_HISTORY_PROOF.RestoredAgreement;
    history: ReorgHistorySnapshot;
};

export type ReorgHistoryProof = ReorgAncestorProof | ReorgRestoredAgreement;

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
}): ReorgHistoryProof | null {
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
    let firstDivergence: number | null = null;
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
            firstDivergence = Math.min(
                firstDivergence ?? stored.number,
                stored.number,
            );
        if (stored.number > 0 && stored.parentHash !== current.parentHash)
            firstDivergence = Math.min(
                firstDivergence ?? stored.number - 1,
                stored.number - 1,
            );
    }
    // A previous disagreement is evidence to verify, not proof that the
    // accepted chain must be replaced. In particular, its base may still agree.
    if (firstDivergence === null)
        return { kind: REORG_HISTORY_PROOF.RestoredAgreement, history };
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
        ? {
              kind: REORG_HISTORY_PROOF.Ancestor,
              fork: { ...fork, chainId: history.checkpoint.chainId },
              history,
          }
        : null;
}
