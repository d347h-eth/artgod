import type { ChainBlockReference, ChainSyncCheckpoint } from "./chain-sync.js";

/** A recent stored block owns a delayed hash check until verification or recovery handoff. */
export type PendingCanonicalCheck = ChainBlockReference & {
    checkpoint: ChainSyncCheckpoint;
};
export type CanonicalCheckPolicy = {
    observedHeadBlock: number;
    reorgDepth: number;
};

/** Preserve the existing depth convention: block N is eligible at HEAD N + depth - 1. */
export function canonicalCheckUpperBound(
    head: number,
    reorgDepth: number,
): number {
    return Math.max(0, head - reorgDepth + 1);
}

export function assertCanonicalCheckPolicy(policy: CanonicalCheckPolicy): void {
    if (
        !policy ||
        !Number.isSafeInteger(policy.observedHeadBlock) ||
        policy.observedHeadBlock < 0 ||
        !Number.isSafeInteger(policy.reorgDepth) ||
        policy.reorgDepth < 1
    )
        throw new Error("Invalid canonical check policy");
}

export function needsDelayedCanonicalCheck(
    blockNumber: number,
    policy: CanonicalCheckPolicy,
): boolean {
    assertCanonicalCheckPolicy(policy);
    return (
        blockNumber >
        canonicalCheckUpperBound(policy.observedHeadBlock, policy.reorgDepth)
    );
}
