import { db } from "@artgod/shared/database";
import type { CanonicalChecksPort } from "../../ports/canonical-checks.js";
import type { PendingCanonicalCheck } from "../../domain/canonical-check.js";
import { ChainSyncConflict } from "../../domain/chain-sync.js";
import {
    assertChainSyncCheckpoint,
    captureChainSyncCheckpoint,
} from "./sqlite-chain-revisions.js";

export class SqliteCanonicalChecks implements CanonicalChecksPort {
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
                    "SELECT chain_id AS chainId,block_number AS blockNumber,block_hash AS blockHash FROM blocks WHERE chain_id=? AND canonical_check_pending=1 AND canonical_check_retry_at<=? AND block_number<=? ORDER BY canonical_check_retry_at,block_number LIMIT 1",
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
                        "UPDATE blocks SET canonical_check_pending=0,canonical_check_retry_at=0 WHERE chain_id=? AND block_number=? AND block_hash=? AND canonical_check_pending=1",
                    )
                    .run(check.chainId, check.blockNumber, check.blockHash)
                    .changes === 1
            );
        })();
    }

    defer(check: PendingCanonicalCheck, retryAt: number): void {
        db.writeTransaction(() => {
            if (check.chainId !== check.checkpoint.chainId)
                throw new ChainSyncConflict("Canonical check chain mismatch");
            assertChainSyncCheckpoint(check.checkpoint);
            db.prepare(
                "UPDATE blocks SET canonical_check_retry_at=? WHERE chain_id=? AND block_number=? AND block_hash=? AND canonical_check_pending=1",
            ).run(retryAt, check.chainId, check.blockNumber, check.blockHash);
        })();
    }
}
