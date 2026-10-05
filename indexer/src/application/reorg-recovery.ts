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
    isCurrentReorgRange,
    type AwaitingReorgAncestor,
    type ReorgRecoveryState,
    type ReorgResync,
    type ReorgResyncRange,
} from "../domain/reorg-recovery.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    BACKFILL_SOURCE,
    type BackfillSyncPayload,
} from "../domain/sync-jobs.js";
import type { JobEnvelope } from "../domain/jobs.js";
import { JobDeferred } from "../domain/job-deferred.js";
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
    Retain: "retain",
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
    // orphan state, advance revision, retain resync and enqueue its first range.
    // next=null explicitly completes recovery when no canonical range remains.
    commitRollbackAndResync(input: {
        expected: AwaitingReorgAncestor;
        proof: ReorgAncestorProof;
        plan: ReorgRollbackPlan;
        snapshot: Erc721RollbackSnapshot;
        next: ReorgResync | null;
        now: number;
    }): void;
    redriveResync(input: {
        expected: ReorgResync;
        retryAt: number;
        now: number;
    }): void;
    // Complete only after persistence AND required downstream publication. Advance
    // the range and its outbox continuation in one transaction; stale jobs do nothing.
    completeResyncRange(input: {
        range: ReorgResyncRange;
        batchSize: number;
        retryAt: number;
        now: number;
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

    async checkBlock(blockNumber: number): Promise<void> {
        if (!Number.isSafeInteger(blockNumber) || blockNumber < 1) return;
        const checkpoint = this.storage.captureSyncCheckpoint(
            this.options.chainId,
        );
        const storedHash = this.storage.getBlockHash(
            this.options.chainId,
            blockNumber,
        );
        if (!storedHash) return;
        const block = await this.rpc.getBlock(blockNumber, { fresh: true });
        if (block.number !== blockNumber)
            throw new ChainSyncConflict(
                "Block check RPC returned the wrong block",
            );
        if (block.hash === storedHash) return;
        try {
            this.recoveries.retainMismatch({
                checkpoint,
                checkedBlock: blockNumber,
                storedHash,
                observedHash: block.hash,
                recoveryId: randomUUID(),
                now: this.now(),
            });
        } catch (error) {
            // Until this write commits, the original check is the only recovery
            // owner. Keep it retryable even beyond the usual transport DLQ budget.
            logger.warn("Unable to retain known reorg mismatch", {
                component: REORG_RECOVERY_LOG_COMPONENT,
                action: REORG_RECOVERY_LOG_ACTION.Retain,
                chainId: checkpoint.chainId,
                checkedBlock: blockNumber,
                error: String(error),
            });
            throw new JobDeferred(
                "Reorg mismatch persistence is pending",
                this.retryDelayMs,
            );
        }
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
        if (recovery.phase === REORG_RECOVERY_PHASE.Resync) {
            this.recoveries.redriveResync({
                expected: recovery,
                now: this.now(),
                retryAt: this.now() + this.retryDelayMs,
            });
            return;
        }
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
                retryAt: this.now() + this.retryDelayMs,
            });
            this.recoveries.commitRollbackAndResync({
                expected: recovery,
                proof,
                ...prepared,
                next,
                now: this.now(),
            });
        } catch (error) {
            // The durable workflow owns retry. If persisting retry fails, reject
            // the delivery rather than acknowledging work without recovery ownership.
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
    recovery: RecoverChainReorg,
    pollMs: number = REORG_RECOVERY_POLICY.PollMs,
): () => Promise<void> {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1)
        throw new Error("Invalid reorg recovery polling interval");
    const tick = () =>
        recovery.resumeDue().catch((error) =>
            logger.warn("Reorg recovery continuation failed", {
                component: REORG_RECOVERY_LOG_COMPONENT,
                action: REORG_RECOVERY_LOG_ACTION.Poll,
                error: String(error),
            }),
        );
    let active = tick();
    const timer = setInterval(() => {
        active = tick();
    }, pollMs);
    return async () => {
        clearInterval(timer);
        await active;
    };
}

// Source and recovery identity are explicit queue contracts. A stale/legacy
// reorg hint cannot perform unowned work or complete a newer logical range.
export async function executeReorgResync(
    job: JobEnvelope<BackfillSyncPayload>,
    store: ReorgRecoveryStore,
    policy: { batchSize: number; retryDelayMs?: number; now?: () => number },
    syncAndPublish: () => Promise<void>,
): Promise<boolean> {
    if (
        job.payload.source !== BACKFILL_SOURCE.ReorgRecovery ||
        !job.payload.recovery ||
        job.collectionId !== undefined ||
        job.payload.orderMaintenancePolicy !==
            BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState
    )
        return false;
    const range: ReorgResyncRange = {
        ...job.payload.recovery,
        chainId: job.chainId,
        fromBlock: job.payload.fromBlock,
        toBlock: job.payload.toBlock,
    };
    if (!isCurrentReorgRange(store.getRecovery(job.chainId), range))
        return false;
    await syncAndPublish();
    const now = (policy.now ?? Date.now)();
    return store.completeResyncRange({
        range,
        batchSize: policy.batchSize,
        now,
        retryAt:
            now + (policy.retryDelayMs ?? REORG_RECOVERY_POLICY.RetryDelayMs),
    });
}
