import { db } from "@artgod/shared/database";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { REORG_RECOVERY_PHASE } from "../../domain/reorg-recovery.js";
import {
    SYNC_APPLICATION_KIND,
    type SyncApplication,
} from "../../domain/sync-work.js";
import type { ChainProgressPort } from "../../ports/chain-progress.js";
import type {
    CollectionBaseCandidate,
    SyncCoordinationPort,
} from "../../ports/sync-coordination.js";
import { captureChainSyncCheckpoint } from "./sqlite-chain-revisions.js";

export class SqliteSyncCoordination implements SyncCoordinationPort {
    constructor(
        private readonly progress: Pick<
            ChainProgressPort,
            "collectionProgress"
        >,
    ) {}

    firstInstalledBase(chainId: number) {
        const checkpoint = captureChainSyncCheckpoint(chainId);
        const row = db
            .prepare(
                `SELECT b.anchor_block AS blockNumber,b.anchor_hash AS blockHash
             FROM collection_ownership_bases b JOIN collections c USING(collection_id)
             WHERE b.chain_id=? AND b.revision=? AND c.chain_id=b.chain_id
               AND c.bootstrap_anchor_block=b.anchor_block AND c.status IN (?,?)
             ORDER BY b.anchor_block,b.collection_id LIMIT 1`,
            )
            .get(
                chainId,
                checkpoint.revision,
                COLLECTION_STATUS.Live,
                COLLECTION_STATUS.Bootstrapping,
            ) as { blockNumber: number; blockHash: string } | undefined;
        return row ? { ...row, chainId, checkpoint } : null;
    }

    unacceptedCollectionBases(
        chainId: number,
        now: number,
        limit: number,
    ): CollectionBaseCandidate[] {
        const checkpoint = captureChainSyncCheckpoint(chainId);
        const rows = db
            .prepare(
                `SELECT b.collection_id AS collectionId,b.anchor_block AS number,b.anchor_hash AS hash,
                    CASE WHEN b.anchor_block>=s.anchor_block THEN h.parent_hash ELSE NULL END AS parentHash,
                    CASE WHEN b.anchor_block>=s.anchor_block THEN h.timestamp ELSE NULL END AS timestamp
             FROM collection_ownership_bases b
             JOIN chain_sync_progress s ON s.chain_id=b.chain_id AND s.revision=b.revision
             JOIN collections c ON c.collection_id=b.collection_id AND c.chain_id=b.chain_id
             LEFT JOIN blocks h ON h.chain_id=b.chain_id AND h.block_number=b.anchor_block AND h.block_hash=b.anchor_hash
             LEFT JOIN collection_sync_progress p ON p.chain_id=b.chain_id AND p.collection_id=b.collection_id
             WHERE b.chain_id=? AND b.revision=? AND p.collection_id IS NULL AND b.anchor_block<=s.applied_block
               AND (b.anchor_block<s.anchor_block OR h.block_number IS NOT NULL)
               AND b.retry_at<=? AND c.bootstrap_anchor_block=b.anchor_block AND c.status IN (?,?)
             ORDER BY b.last_attempt_at,b.collection_id LIMIT ?`,
            )
            .all(
                chainId,
                checkpoint.revision,
                now,
                COLLECTION_STATUS.Live,
                COLLECTION_STATUS.Bootstrapping,
                limit,
            ) as {
            collectionId: number;
            number: number;
            hash: string;
            parentHash: string | null;
            timestamp: number | null;
        }[];
        return rows.map(
            ({ collectionId, number, hash, parentHash, timestamp }) => ({
                checkpoint,
                collectionId,
                anchor: { number, hash },
                acceptedHeader:
                    parentHash !== null && timestamp !== null
                        ? { number, hash, parentHash, timestamp }
                        : null,
            }),
        );
    }

    recordBaseAttempt(
        base: CollectionBaseCandidate,
        now: number,
        retryAt: number,
    ): void {
        db.prepare(
            "UPDATE collection_ownership_bases SET last_attempt_at=?,retry_at=? WHERE chain_id=? AND collection_id=? AND revision=? AND anchor_block=? AND anchor_hash=?",
        ).run(
            now,
            retryAt,
            base.checkpoint.chainId,
            base.collectionId,
            base.checkpoint.revision,
            base.anchor.number,
            base.anchor.hash,
        );
    }

    nextCollectionCatchup(chainId: number, now: number) {
        const row = db
            .prepare(
                `SELECT p.collection_id AS collectionId
             FROM collection_sync_progress p
             JOIN chain_sync_progress s ON s.chain_id=p.chain_id AND s.revision=p.revision
             JOIN collections c ON c.collection_id=p.collection_id AND c.chain_id=p.chain_id
             WHERE p.chain_id=? AND p.retry_at<=? AND p.applied_block<s.applied_block
               AND c.bootstrap_anchor_block=p.anchor_block AND c.status IN (?,?)
             ORDER BY p.last_attempt_at,p.collection_id LIMIT 1`,
            )
            .get(
                chainId,
                now,
                COLLECTION_STATUS.Live,
                COLLECTION_STATUS.Bootstrapping,
            ) as { collectionId: number } | undefined;
        return row
            ? this.progress.collectionProgress(chainId, row.collectionId)
            : null;
    }

    sharedDue(chainId: number, now: number): boolean {
        return Boolean(
            db
                .prepare(
                    "SELECT 1 FROM chain_sync_progress WHERE chain_id=? AND retry_at<=?",
                )
                .get(chainId, now),
        );
    }

    canAdvance(chainId: number): boolean {
        return Boolean(
            db
                .prepare(
                    `SELECT 1 FROM chain_sync_progress s WHERE s.chain_id=? AND s.disputed_from IS NULL
             AND NOT EXISTS (SELECT 1 FROM chain_reorg_recoveries r WHERE r.chain_id=s.chain_id AND r.phase=?)`,
                )
                .get(chainId, REORG_RECOVERY_PHASE.AwaitingAncestor),
        );
    }

    recordAttempt(
        application: SyncApplication,
        now: number,
        retryAt: number,
    ): void {
        if (application.kind !== SYNC_APPLICATION_KIND.Applied) return;
        db.writeTransaction(() => {
            if (application.chain) {
                const expected = application.chain;
                db.prepare(
                    "UPDATE chain_sync_progress SET last_attempt_at=?,retry_at=? WHERE chain_id=? AND revision=? AND applied_block=? AND applied_hash=?",
                ).run(
                    now,
                    retryAt,
                    expected.checkpoint.chainId,
                    expected.checkpoint.revision,
                    expected.applied.number,
                    expected.applied.hash,
                );
            }
            for (const expected of application.collections)
                db.prepare(
                    "UPDATE collection_sync_progress SET last_attempt_at=?,retry_at=? WHERE chain_id=? AND collection_id=? AND revision=? AND applied_block=? AND applied_hash=?",
                ).run(
                    now,
                    retryAt,
                    expected.checkpoint.chainId,
                    expected.collectionId,
                    expected.checkpoint.revision,
                    expected.applied.number,
                    expected.applied.hash,
                );
        })();
    }
}
