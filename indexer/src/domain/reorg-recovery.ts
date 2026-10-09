import { ChainSyncConflict, type ChainSyncCheckpoint } from "./chain-sync.js";
export const REORG_RECOVERY_PHASE = {
    AwaitingAncestor: "awaiting_ancestor",
    Resync: "resync",
} as const;
export const REORG_RECOVERY_POLICY = {
    PollMs: 12_000,
    RetryDelayMs: 300_000,
} as const;
export const REORG_RECOVERY_LOG_COMPONENT = "ReorgRecovery";

export type ReorgResyncIdentity = { recoveryId: string; revision: number };
export type ReorgResyncRange = ReorgResyncIdentity & {
    chainId: number;
    fromBlock: number;
    toBlock: number;
};

type RecoveryBase = ReorgResyncIdentity & {
    chainId: number;
    version: number;
    checkedBlock: number;
    storedHash: string;
    observedHash: string;
    retryAt: number;
};
export type AwaitingReorgAncestor = RecoveryBase & {
    phase: typeof REORG_RECOVERY_PHASE.AwaitingAncestor;
    // Preserve unfinished acquisition if a new mismatch interrupts canonical resync.
    resumeFrom: number | null;
};
export type ReorgResync = RecoveryBase & {
    phase: typeof REORG_RECOVERY_PHASE.Resync;
    fromBlock: number;
    toBlock: number;
    targetBlock: number;
};
export type ReorgRecoveryState = AwaitingReorgAncestor | ReorgResync;

export function retainReorgMismatch(input: {
    current: ReorgRecoveryState | null;
    checkpoint: ChainSyncCheckpoint;
    recoveryId: string;
    checkedBlock: number;
    storedHash: string;
    observedHash: string;
    now: number;
}): AwaitingReorgAncestor {
    const { current } = input;
    // The lowest known mismatch covers later divergent blocks when rolled back.
    // Repeated checks must not continually invalidate an in-flight proof.
    if (
        current?.phase === REORG_RECOVERY_PHASE.AwaitingAncestor &&
        current.revision === input.checkpoint.revision &&
        current.checkedBlock <= input.checkedBlock
    )
        return current;
    return {
        chainId: input.checkpoint.chainId,
        recoveryId: input.recoveryId,
        revision: input.checkpoint.revision,
        version: (current?.version ?? -1) + 1,
        checkedBlock: input.checkedBlock,
        storedHash: input.storedHash,
        observedHash: input.observedHash,
        phase: REORG_RECOVERY_PHASE.AwaitingAncestor,
        retryAt: input.now,
        resumeFrom:
            current?.phase === REORG_RECOVERY_PHASE.Resync
                ? current.fromBlock
                : (current?.resumeFrom ?? null),
    };
}

// Capture a finite canonical window. null means rollback reaches the observed
// head and there is no interrupted earlier range still requiring sync/fanout.
export function beginReorgResync(input: {
    recovery: AwaitingReorgAncestor;
    rollbackFrom: number;
    head: number;
    batchSize: number;
    retryAt: number;
}): ReorgResync | null {
    if (input.head < input.rollbackFrom - 1)
        throw new ChainSyncConflict(
            "Recovery head is behind the verified fork",
        );
    const fromBlock = Math.min(
        input.rollbackFrom,
        input.recovery.resumeFrom ?? input.rollbackFrom,
    );
    if (fromBlock > input.head) return null;
    const { resumeFrom: _resumeFrom, phase: _phase, ...base } = input.recovery;
    return {
        ...base,
        phase: REORG_RECOVERY_PHASE.Resync,
        revision: input.recovery.revision + 1,
        version: input.recovery.version + 1,
        fromBlock,
        toBlock: Math.min(input.head, fromBlock + input.batchSize - 1),
        targetBlock: input.head,
        retryAt: input.retryAt,
    };
}

export function advanceReorgResync(input: {
    recovery: ReorgResync;
    batchSize: number;
    retryAt: number;
}): ReorgResync | null {
    const fromBlock = input.recovery.toBlock + 1;
    if (fromBlock > input.recovery.targetBlock) return null;
    return {
        ...input.recovery,
        version: input.recovery.version + 1,
        fromBlock,
        toBlock: Math.min(
            input.recovery.targetBlock,
            fromBlock + input.batchSize - 1,
        ),
        retryAt: input.retryAt,
    };
}

export function isCurrentReorgRange(
    recovery: ReorgRecoveryState | null,
    range: ReorgResyncRange,
): recovery is ReorgResync {
    return (
        recovery?.phase === REORG_RECOVERY_PHASE.Resync &&
        recovery.chainId === range.chainId &&
        recovery.recoveryId === range.recoveryId &&
        recovery.revision === range.revision &&
        recovery.fromBlock === range.fromBlock &&
        recovery.toBlock === range.toBlock
    );
}
