import { db } from "@artgod/shared/database";
import type { CanonicalChecksPort } from "../../ports/canonical-checks.js";
import type { PendingCanonicalCheck } from "../../domain/canonical-check.js";
import {
    ChainSyncConflict,
    type ChainSyncCheckpoint,
} from "../../domain/chain-sync.js";
import {
    assertChainSyncCheckpoint,
    captureChainSyncCheckpoint,
} from "./sqlite-chain-revisions.js";

export class SqliteCanonicalChecks implements CanonicalChecksPort {
    retain(
        check: PendingCanonicalCheck,
        options?: { disputed: boolean },
    ): boolean {
        return db.writeTransaction(() => {
            if (check.chainId !== check.checkpoint.chainId)
                throw new ChainSyncConflict("Canonical check chain mismatch");
            assertChainSyncCheckpoint(check.checkpoint);
            const retained =
                db
                    .prepare(
                        "UPDATE blocks SET canonical_check_retry_at=CASE WHEN @disputed=1 OR canonical_check_pending=0 THEN 0 ELSE canonical_check_retry_at END,canonical_check_pending=1, " +
                            "canonical_check_disputed=MAX(canonical_check_disputed,@disputed),canonical_check_generation=canonical_check_generation+@disputed " +
                            "WHERE chain_id=@chainId AND block_number=@blockNumber AND block_hash=@blockHash",
                    )
                    .run({
                        chainId: check.chainId,
                        blockNumber: check.blockNumber,
                        blockHash: check.blockHash,
                        disputed: options?.disputed ? 1 : 0,
                    }).changes === 1;
            if (retained && options?.disputed)
                db.prepare(
                    "UPDATE chain_sync_progress SET disputed_from=CASE WHEN disputed_from IS NULL THEN ? ELSE MIN(disputed_from,?) END WHERE chain_id=?",
                ).run(check.blockNumber, check.blockNumber, check.chainId);
            return retained;
        })();
    }

    hasPending(chainId: number, now: number): boolean {
        return !!db
            .prepare(
                "SELECT 1 FROM blocks WHERE chain_id=? AND canonical_check_pending=1 AND canonical_check_retry_at<=? LIMIT 1",
            )
            .get(chainId, now);
    }

    nextDue({
        chainId,
        now,
        upperBound,
    }: Parameters<
        CanonicalChecksPort["nextDue"]
    >[0]): PendingCanonicalCheck | null {
        return db.raw.transaction(() => {
            const block = db
                .prepare(
                    "SELECT chain_id AS chainId,block_number AS blockNumber,block_hash AS blockHash,canonical_check_generation AS generation FROM blocks WHERE chain_id=? AND canonical_check_pending=1 AND canonical_check_retry_at<=? AND (block_number<=? OR canonical_check_disputed=1) ORDER BY canonical_check_disputed DESC,canonical_check_retry_at,block_number LIMIT 1",
                )
                .get(chainId, now, upperBound) as
                | Omit<PendingCanonicalCheck, "checkpoint">
                | undefined;
            return block
                ? { ...block, checkpoint: captureChainSyncCheckpoint(chainId) }
                : null;
        })();
    }

    complete(check: PendingCanonicalCheck): boolean {
        return db.writeTransaction(() => {
            if (check.chainId !== check.checkpoint.chainId)
                throw new ChainSyncConflict("Canonical check chain mismatch");
            assertChainSyncCheckpoint(check.checkpoint);
            return (
                db
                    .prepare(
                        "UPDATE blocks SET canonical_check_pending=0,canonical_check_retry_at=0 WHERE chain_id=? AND block_number=? AND block_hash=? AND canonical_check_pending=1 AND (? IS NULL OR canonical_check_generation=?)",
                    )
                    .run(
                        check.chainId,
                        check.blockNumber,
                        check.blockHash,
                        check.generation ?? null,
                        check.generation ?? null,
                    ).changes === 1
            );
        })();
    }

    confirmCanonicalBlock(check: PendingCanonicalCheck): boolean {
        return db.writeTransaction(() => {
            // An unclaimed original check can confirm generation zero only.
            // A newer conflict retained during RPC must remain pending/gated.
            const generation = check.generation ?? 0;
            if (!this.complete({ ...check, generation })) return false;
            db.prepare(
                "UPDATE blocks SET canonical_check_disputed=0 WHERE chain_id=? AND block_number=? AND block_hash=? AND canonical_check_generation=?",
            ).run(
                check.chainId,
                check.blockNumber,
                check.blockHash,
                generation,
            );
            db.prepare(
                "UPDATE chain_head_samples SET block_hash=? WHERE chain_id=? AND revision=? AND block_number=?",
            ).run(
                check.blockHash,
                check.chainId,
                check.checkpoint.revision,
                check.blockNumber,
            );
            db.prepare(
                "UPDATE chain_sync_progress SET disputed_from=(SELECT MIN(block_number) FROM blocks WHERE chain_id=? AND canonical_check_disputed=1) WHERE chain_id=?",
            ).run(check.chainId, check.chainId);
            return true;
        })();
    }

    handoffToRecovery(check: PendingCanonicalCheck): boolean {
        return db.writeTransaction(() => {
            if (!this.complete(check)) return false;
            // Unlike a successful check, recovery retains the disagreement
            // even when an earlier mismatch already owns the journal.
            db.prepare(
                "UPDATE blocks SET canonical_check_disputed=1,canonical_check_generation=canonical_check_generation+1 WHERE chain_id=? AND block_number=? AND block_hash=?",
            ).run(check.chainId, check.blockNumber, check.blockHash);
            db.prepare(
                "UPDATE chain_sync_progress SET disputed_from=CASE WHEN disputed_from IS NULL THEN ? ELSE MIN(disputed_from,?) END WHERE chain_id=?",
            ).run(check.blockNumber, check.blockNumber, check.chainId);
            return true;
        })();
    }

    resumeDisputes(checkpoint: ChainSyncCheckpoint): void {
        db.writeTransaction(() => {
            assertChainSyncCheckpoint(checkpoint);
            db.prepare(
                "UPDATE blocks SET canonical_check_pending=1,canonical_check_retry_at=0 WHERE chain_id=? AND canonical_check_disputed=1",
            ).run(checkpoint.chainId);
        })();
    }

    defer(check: PendingCanonicalCheck, retryAt: number): void {
        db.writeTransaction(() => {
            if (check.chainId !== check.checkpoint.chainId)
                throw new ChainSyncConflict("Canonical check chain mismatch");
            assertChainSyncCheckpoint(check.checkpoint);
            db.prepare(
                "UPDATE blocks SET canonical_check_retry_at=? WHERE chain_id=? AND block_number=? AND block_hash=? AND canonical_check_pending=1 AND canonical_check_generation=?",
            ).run(
                retryAt,
                check.chainId,
                check.blockNumber,
                check.blockHash,
                check.generation ?? 0,
            );
        })();
    }
}
