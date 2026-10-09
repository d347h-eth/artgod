import { db } from "@artgod/shared/database";
import { ChainSyncConflict } from "../../domain/chain-sync.js";
import {
    REORG_RECOVERY_PHASE,
    retainReorgMismatch,
    advanceReorgResync,
    isCurrentReorgRange,
    type ReorgRecoveryState,
} from "../../domain/reorg-recovery.js";
import type { ReorgRecoveryStore } from "../../application/reorg-recovery.js";
import type { SqliteStorage } from "./sqlite.js";
import type { CanonicalChecksPort } from "../../ports/canonical-checks.js";

type RecoveryRow = {
    chain_id: number;
    recovery_id: string;
    version: number;
    revision: number;
    checked_block: number;
    stored_hash: string;
    observed_hash: string;
    phase: ReorgRecoveryState["phase"];
    retry_at: number;
    range_from: number | null;
    range_to: number | null;
    target_block: number | null;
};

// One adapter owns the atomic rollback and retained resync progress. Pure
// recovery transitions live in the domain; SQL and nested adapter writes stay here.
export class SqliteReorgRecoveries implements ReorgRecoveryStore {
    constructor(
        private readonly storage: SqliteStorage,
        private readonly checks: CanonicalChecksPort,
    ) {}

    getRecovery(chainId: number): ReorgRecoveryState | null {
        const row = db
            .prepare("SELECT * FROM chain_reorg_recoveries WHERE chain_id = ?")
            .get(chainId) as RecoveryRow | undefined;
        if (!row) return null;
        const base = {
            chainId: row.chain_id,
            recoveryId: row.recovery_id,
            version: row.version,
            revision: row.revision,
            checkedBlock: row.checked_block,
            storedHash: row.stored_hash,
            observedHash: row.observed_hash,
            retryAt: row.retry_at,
        };
        if (row.phase === REORG_RECOVERY_PHASE.AwaitingAncestor)
            return { ...base, phase: row.phase, resumeFrom: row.range_from };
        if (
            row.range_from === null ||
            row.range_to === null ||
            row.target_block === null
        )
            throw new Error("Incomplete persisted reorg resync range");
        return {
            ...base,
            phase: row.phase,
            fromBlock: row.range_from,
            toBlock: row.range_to,
            targetBlock: row.target_block,
        };
    }

    retainMismatch(input: Parameters<ReorgRecoveryStore["retainMismatch"]>[0]) {
        return db.writeTransaction(() => {
            this.assertCheckpoint(
                input.checkpoint.chainId,
                input.checkpoint.revision,
            );
            if (
                this.storage.getBlockHash(
                    input.checkpoint.chainId,
                    input.checkedBlock,
                ) !== input.storedHash
            )
                throw new ChainSyncConflict(
                    "Mismatch no longer describes persisted history",
                );
            const current = this.getRecovery(input.checkpoint.chainId);
            const next = retainReorgMismatch({ ...input, current });
            if (next !== current) {
                this.save(next);
            }
            if (
                !this.checks.complete({
                    checkpoint: input.checkpoint,
                    chainId: input.checkpoint.chainId,
                    blockNumber: input.checkedBlock,
                    blockHash: input.storedHash,
                })
            )
                throw new ChainSyncConflict(
                    "Mismatch check no longer describes pending verification",
                );
            return next;
        })();
    }

    refreshCheckpoint(
        input: Parameters<ReorgRecoveryStore["refreshCheckpoint"]>[0],
    ): void {
        db.writeTransaction(() => {
            this.assertCurrent(input.expected);
            this.assertCheckpoint(
                input.checkpoint.chainId,
                input.checkpoint.revision,
            );
            this.save(
                retainReorgMismatch({
                    current: input.expected,
                    checkpoint: input.checkpoint,
                    recoveryId: input.recoveryId,
                    checkedBlock: input.expected.checkedBlock,
                    storedHash: input.expected.storedHash,
                    observedHash: input.expected.observedHash,
                    now: input.now,
                }),
            );
        })();
    }

    deferProof(input: Parameters<ReorgRecoveryStore["deferProof"]>[0]): void {
        db.prepare(
            "UPDATE chain_reorg_recoveries SET retry_at = ?, last_error = ? WHERE chain_id = ? AND recovery_id = ? AND version = ? AND phase = ?",
        ).run(
            input.retryAt,
            input.error,
            input.expected.chainId,
            input.expected.recoveryId,
            input.expected.version,
            REORG_RECOVERY_PHASE.AwaitingAncestor,
        );
    }

    commitRollbackAndResync(
        input: Parameters<ReorgRecoveryStore["commitRollbackAndResync"]>[0],
    ): void {
        db.writeTransaction(() => {
            this.assertCurrent(input.expected);
            if (
                input.plan.checkpoint.chainId !== input.expected.chainId ||
                input.plan.checkpoint.revision !== input.expected.revision ||
                input.proof.history.checkpoint.chainId !==
                    input.expected.chainId ||
                input.proof.history.checkpoint.revision !==
                    input.expected.revision ||
                input.proof.history.toBlock !== input.expected.checkedBlock ||
                input.proof.fork.chainId !== input.expected.chainId ||
                input.proof.fork.number < input.proof.history.fromBlock ||
                input.proof.fork.number >= input.proof.history.toBlock ||
                input.plan.fromBlock !== input.proof.fork.number + 1 ||
                input.snapshot.block.blockHash !== input.proof.fork.hash
            )
                throw new ChainSyncConflict(
                    "Rollback plan does not match recovery ancestor proof",
                );
            this.storage.assertReorgHistoryUnchanged(input.proof.history);
            if (
                input.next &&
                (input.next.chainId !== input.expected.chainId ||
                    input.next.recoveryId !== input.expected.recoveryId ||
                    input.next.version !== input.expected.version + 1 ||
                    input.next.revision !== input.expected.revision + 1)
            )
                throw new ChainSyncConflict(
                    "Resync continuation does not match rollback",
                );
            this.storage.rollbackFromBlock({
                plan: input.plan,
                snapshot: input.snapshot,
            });
            if (input.next) this.save(input.next);
            else this.remove(input.expected.chainId);
        })();
    }

    deferResync(input: Parameters<ReorgRecoveryStore["deferResync"]>[0]): void {
        db.prepare(
            "UPDATE chain_reorg_recoveries SET retry_at = @retryAt, last_error = @error WHERE chain_id = @chainId AND recovery_id = @recoveryId AND revision = @revision AND phase = @phase AND range_from = @fromBlock AND range_to = @toBlock",
        ).run({
            ...input.range,
            retryAt: input.retryAt,
            error: input.error,
            phase: REORG_RECOVERY_PHASE.Resync,
        });
    }

    completeResyncRange(
        input: Parameters<ReorgRecoveryStore["completeResyncRange"]>[0],
    ): boolean {
        return db.writeTransaction(() => {
            const current = this.getRecovery(input.range.chainId);
            if (!isCurrentReorgRange(current, input.range)) return false;
            this.assertCheckpoint(current.chainId, current.revision);
            const next = advanceReorgResync({
                recovery: current,
                batchSize: input.batchSize,
                retryAt: input.retryAt,
            });
            if (next) this.save(next);
            else this.remove(current.chainId);
            return true;
        })();
    }

    private assertCheckpoint(chainId: number, revision: number): void {
        if (this.storage.captureSyncCheckpoint(chainId).revision !== revision)
            throw new ChainSyncConflict("Recovery chain revision changed");
    }

    private assertCurrent(expected: ReorgRecoveryState): void {
        const current = this.getRecovery(expected.chainId);
        if (
            !current ||
            current.recoveryId !== expected.recoveryId ||
            current.revision !== expected.revision ||
            current.version !== expected.version ||
            current.phase !== expected.phase
        )
            throw new ChainSyncConflict(
                "Reorg recovery changed during processing",
            );
    }

    private remove(chainId: number): void {
        db.prepare("DELETE FROM chain_reorg_recoveries WHERE chain_id = ?").run(
            chainId,
        );
    }

    private save(state: ReorgRecoveryState): void {
        const resync = state.phase === REORG_RECOVERY_PHASE.Resync;
        db.prepare(
            "INSERT INTO chain_reorg_recoveries (chain_id, recovery_id, version, revision, checked_block, stored_hash, observed_hash, phase, retry_at, range_from, range_to, target_block) VALUES (@chainId, @recoveryId, @version, @revision, @checkedBlock, @storedHash, @observedHash, @phase, @retryAt, @rangeFrom, @rangeTo, @targetBlock) ON CONFLICT(chain_id) DO UPDATE SET recovery_id=excluded.recovery_id, version=excluded.version, revision=excluded.revision, checked_block=excluded.checked_block, stored_hash=excluded.stored_hash, observed_hash=excluded.observed_hash, phase=excluded.phase, retry_at=excluded.retry_at, range_from=excluded.range_from, range_to=excluded.range_to, target_block=excluded.target_block, last_error=NULL",
        ).run({
            ...state,
            rangeFrom: resync ? state.fromBlock : state.resumeFrom,
            rangeTo: resync ? state.toBlock : null,
            targetBlock: resync ? state.targetBlock : null,
        });
    }
}
