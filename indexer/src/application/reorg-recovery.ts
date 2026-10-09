import { randomUUID } from "node:crypto";
import { logger } from "@artgod/shared/utils";
import {
    ChainSyncConflict,
    type ChainSyncCheckpoint,
} from "../domain/chain-sync.js";
import {
    REORG_RECOVERY_PHASE,
    REORG_RECOVERY_POLICY,
    REORG_RECOVERY_LOG_COMPONENT,
    beginReorgResync,
    type AwaitingReorgAncestor,
    type ReorgRecoveryState,
    type ReorgResync,
    type ReorgResyncRange,
} from "../domain/reorg-recovery.js";
import {
    canonicalCheckUpperBound,
    type PendingCanonicalCheck,
} from "../domain/canonical-check.js";
import type { CanonicalChecksPort } from "../ports/canonical-checks.js";
import type { RpcProviderPort } from "../ports/rpc.js";
import type { StoragePort } from "../ports/storage.js";
import { findCommonAncestor, type ReorgForkStore } from "./reorg-fork.js";
import type { ReorgAncestorProof } from "../domain/reorg-fork.js";
import {
    RollbackChainRange,
    type ReorgRollbackPlan,
    type Erc721RollbackSnapshot,
} from "./reorg-rollback.js";

const REORG_RECOVERY_LOG_ACTION = {
    Resume: "resume",
    Poll: "poll",
    Check: "check",
} as const;

export interface ReorgRecoveryStore {
    getRecovery(chainId: number): ReorgRecoveryState | null;
    // Retain mismatch only if its stored hash/revision still describe local state.
    retainMismatch(input: {
        checkpoint: ChainSyncCheckpoint;
        recoveryId: string;
        checkedBlock: number;
        storedHash: string;
        observedHash: string;
        now: number;
    }): AwaitingReorgAncestor;
    refreshCheckpoint(input: {
        expected: ReorgRecoveryState;
        checkpoint: ChainSyncCheckpoint;
        recoveryId: string;
        now: number;
    }): void;
    deferProof(input: {
        expected: AwaitingReorgAncestor;
        retryAt: number;
        error: string | null;
    }): void;
    // Atomically revalidate recovery, ancestor evidence and rollback, remove
    // orphan state, advance revision and retain canonical resync progress.
    // next=null explicitly completes recovery when no canonical range remains.
    commitRollbackAndResync(input: {
        expected: AwaitingReorgAncestor;
        proof: ReorgAncestorProof;
        plan: ReorgRollbackPlan;
        snapshot: Erc721RollbackSnapshot;
        next: ReorgResync | null;
    }): void;
    // Delay one failed acquisition without creating another broker delivery.
    deferResync(input: {
        range: ReorgResyncRange;
        retryAt: number;
        error: string;
    }): void;
    // Advance only in the transaction retaining data and every required follow-up.
    completeResyncRange(input: {
        range: ReorgResyncRange;
        batchSize: number;
        retryAt: number;
    }): boolean;
}

export type ReorgRecoveryOptions = {
    chainId: number;
    reorgDepth: number;
    batchSize: number;
    retryDelayMs?: number;
    now?: () => number;
};

export class RecoverChainReorg {
    private active: Promise<void> | null = null;
    private readonly now: () => number;
    private readonly retryDelayMs: number;
    constructor(
        private readonly rpc: Pick<
            RpcProviderPort,
            "getBlock" | "getBlockNumber"
        >,
        private readonly storage: Pick<
            StoragePort,
            "captureSyncCheckpoint" | "getBlockHash"
        > &
            ReorgForkStore,
        private readonly recoveries: ReorgRecoveryStore,
        private readonly rollback: RollbackChainRange,
        private readonly checks: CanonicalChecksPort,
        private readonly options: ReorgRecoveryOptions,
    ) {
        this.now = options.now ?? Date.now;
        this.retryDelayMs =
            options.retryDelayMs ?? REORG_RECOVERY_POLICY.RetryDelayMs;
        for (const value of [
            options.chainId,
            options.reorgDepth,
            options.batchSize,
            this.retryDelayMs,
        ])
            if (!Number.isSafeInteger(value) || value < 1)
                throw new Error("Invalid reorg recovery policy");
    }

    /** Read eligible retained checks even when their blocks aged past today's realtime tail. */
    async checkDue(): Promise<boolean> {
        if (
            this.recoveries.getRecovery(this.options.chainId) ||
            !this.checks.hasPending(this.options.chainId, this.now())
        )
            return false;
        const head = await this.rpc.getBlockNumber();
        const check = this.checks.nextDue({
            chainId: this.options.chainId,
            now: this.now(),
            upperBound: canonicalCheckUpperBound(head, this.options.reorgDepth),
        });
        if (!check) return false;
        await this.checkBlock(check);
        return true;
    }

    /** Verify one explicit stored identity; success consumes it only in the DB writer. */
    async checkBlock(check: PendingCanonicalCheck): Promise<void> {
        const { blockNumber, blockHash: storedHash, checkpoint } = check;
        if (
            check.chainId !== this.options.chainId ||
            checkpoint.chainId !== check.chainId
        )
            throw new Error("Canonical check chain mismatch");
        try {
            if (
                this.storage.captureSyncCheckpoint(check.chainId).revision !==
                    checkpoint.revision ||
                this.storage.getBlockHash(check.chainId, blockNumber) !==
                    storedHash
            )
                return;
            const block = await this.rpc.getBlock(blockNumber, { fresh: true });
            if (block.number !== blockNumber)
                throw new ChainSyncConflict(
                    "Block check RPC returned the wrong block",
                );
            if (block.hash === storedHash) {
                this.checks.complete(check);
                return;
            }
            this.recoveries.retainMismatch({
                checkpoint,
                checkedBlock: blockNumber,
                storedHash,
                observedHash: block.hash,
                recoveryId: randomUUID(),
                now: this.now(),
            });
        } catch (error) {
            logger.warn("Canonical check remains pending", {
                component: REORG_RECOVERY_LOG_COMPONENT,
                action: REORG_RECOVERY_LOG_ACTION.Check,
                chainId: this.options.chainId,
                checkedBlock: blockNumber,
                error: String(error),
            });
            // Rollback may have removed this exact check during RPC. Otherwise
            // keep it pending regardless of failures or process restarts.
            if (
                this.storage.captureSyncCheckpoint(check.chainId).revision ===
                checkpoint.revision
            )
                this.checks.defer(check, this.now() + this.retryDelayMs);
            return;
        }
        // After retention, SQLite owns retry even if this continuation fails.
        await this.resumeDue();
    }

    // One local attempt at a time; persisted identity/version fence cross-process
    // writes and make the same continuation recoverable after a restart.
    resumeDue(): Promise<void> {
        if (!this.active)
            this.active = this.resume().finally(() => {
                this.active = null;
            });
        return this.active;
    }

    private async resume(): Promise<void> {
        const recovery = this.recoveries.getRecovery(this.options.chainId);
        if (!recovery || recovery.retryAt > this.now()) return;
        const checkpoint = this.storage.captureSyncCheckpoint(
            this.options.chainId,
        );
        if (checkpoint.revision !== recovery.revision) {
            this.recoveries.refreshCheckpoint({
                expected: recovery,
                checkpoint,
                recoveryId: randomUUID(),
                now: this.now(),
            });
            return;
        }
        // The sync runtime owns canonical range execution. Proof polling only
        // retains/revalidates the journal; it never publishes a range continuation.
        if (recovery.phase === REORG_RECOVERY_PHASE.Resync) return;
        try {
            const proof = await findCommonAncestor({
                rpc: this.rpc,
                storage: this.storage,
                chainId: recovery.chainId,
                startBlock: recovery.checkedBlock,
                reorgDepth: this.options.reorgDepth,
            });
            if (!proof) {
                this.recoveries.deferProof({
                    expected: recovery,
                    retryAt: this.now() + this.retryDelayMs,
                    error: "No verified common ancestor",
                });
                logger.warn("Reorg recovery is waiting for ancestor proof", {
                    component: REORG_RECOVERY_LOG_COMPONENT,
                    action: REORG_RECOVERY_LOG_ACTION.Resume,
                    chainId: recovery.chainId,
                    recoveryId: recovery.recoveryId,
                    checkedBlock: recovery.checkedBlock,
                });
                return;
            }
            const prepared = await this.rollback.prepare(proof.fork);
            if (prepared.plan.checkpoint.revision !== recovery.revision)
                throw new ChainSyncConflict(
                    "Recovery revision changed before rollback preparation",
                );
            const head = await this.rpc.getBlockNumber();
            const next = beginReorgResync({
                recovery,
                rollbackFrom: prepared.plan.fromBlock,
                head,
                batchSize: this.options.batchSize,
                retryAt: this.now(),
            });
            this.recoveries.commitRollbackAndResync({
                expected: recovery,
                proof,
                ...prepared,
                next,
            });
        } catch (error) {
            // The journal owns retry. A failed retry write leaves that journal
            // intact for the next DB poll or process restart.
            this.recoveries.deferProof({
                expected: recovery,
                retryAt: this.now() + this.retryDelayMs,
                error: String(error),
            });
            logger.warn("Reorg recovery remains pending", {
                component: REORG_RECOVERY_LOG_COMPONENT,
                action: REORG_RECOVERY_LOG_ACTION.Resume,
                chainId: recovery.chainId,
                recoveryId: recovery.recoveryId,
                error: String(error),
            });
        }
    }
}

export function startReorgRecoveryLoop(
    recovery: Pick<RecoverChainReorg, "resumeDue" | "checkDue">,
    pollMs: number = REORG_RECOVERY_POLICY.PollMs,
): () => Promise<void> {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1)
        throw new Error("Invalid reorg recovery polling interval");
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const run = async () => {
        while (!stopped) {
            let busy = false;
            try {
                await recovery.resumeDue();
                if (!stopped) busy = await recovery.checkDue();
            } catch (error) {
                logger.warn("Reorg recovery continuation failed", {
                    component: REORG_RECOVERY_LOG_COMPONENT,
                    action: REORG_RECOVERY_LOG_ACTION.Poll,
                    error: String(error),
                });
            }
            if (!stopped)
                await new Promise<void>((resolve) => {
                    wake = resolve;
                    timer = setTimeout(resolve, busy ? 0 : pollMs);
                });
        }
    };
    const active = run();
    return async () => {
        stopped = true;
        clearTimeout(timer);
        wake?.();
        await active;
    };
}
