import { db } from "@artgod/shared/database";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
} from "@artgod/shared/bootstrap/pipeline";
import { bootstrapCatchupAuthority } from "../bootstrap/sqlite-catchup-authority.js";
import { BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD } from "../../application/bootstrap-backfill-executor.js";
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

    unacceptedCollectionBases(
        chainId: number,
        now: number,
        limit: number,
    ): CollectionBaseCandidate[] {
        const checkpoint = captureChainSyncCheckpoint(chainId);
        const rows = db
            .prepare(
                `SELECT c.collection_id AS collectionId,r.run_id AS runId,
                    r.anchor_block AS number,r.anchor_block_hash AS hash,
                    CASE WHEN r.anchor_block>=chain.anchor_block THEN h.parent_hash END AS parentHash,CASE WHEN r.anchor_block>=chain.anchor_block THEN h.timestamp END AS timestamp
             FROM collections c
             JOIN bootstrap_runs r ON r.chain_id=c.chain_id AND r.collection_id=c.collection_id
             JOIN bootstrap_run_steps s ON s.run_id=r.run_id AND s.step_key=?
             JOIN chain_sync_progress chain ON chain.chain_id=c.chain_id
             LEFT JOIN collection_sync_progress p ON p.chain_id=c.chain_id AND p.collection_id=c.collection_id
             LEFT JOIN blocks h ON h.chain_id=c.chain_id AND h.block_number=r.anchor_block AND h.block_hash=r.anchor_block_hash
             WHERE c.chain_id=? AND c.status=? AND r.status=? AND p.collection_id IS NULL
               AND r.anchor_block<=chain.applied_block AND c.bootstrap_anchor_block=r.anchor_block
               AND (r.anchor_block<chain.anchor_block OR h.block_number IS NOT NULL)
               AND json_valid(s.result_json)
               AND COALESCE(json_extract(s.result_json,'$.${BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.BaseRetryAt}'),0)<=?
               AND r.run_id=(SELECT MAX(current.run_id) FROM bootstrap_runs current WHERE current.chain_id=r.chain_id AND current.collection_id=r.collection_id)
             ORDER BY COALESCE(json_extract(s.result_json,'$.${BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.BaseRetryAt}'),0),c.collection_id`,
            )
            .iterate(
                BOOTSTRAP_STEP_KEY.Backfill,
                chainId,
                COLLECTION_STATUS.Bootstrapping,
                BOOTSTRAP_RUN_STATUS.Backfill,
                now,
            ) as Iterable<{
            collectionId: number;
            runId: number;
            number: number;
            hash: string;
            parentHash: string | null;
            timestamp: number | null;
        }>;
        const candidates: CollectionBaseCandidate[] = [];
        // Apply the owning authority check before the limit. An invalid or
        // terminal step must never hide an unrelated eligible collection.
        for (const {
            collectionId,
            runId,
            number,
            hash,
            parentHash,
            timestamp,
        } of rows) {
            const authority = bootstrapCatchupAuthority(chainId, collectionId);
            if (!authority || authority.runId !== runId) continue;
            candidates.push({
                checkpoint,
                collectionId,
                runId,
                anchor: { number, hash },
                acceptedHeader:
                    parentHash !== null && timestamp !== null
                        ? { number, hash, parentHash, timestamp }
                        : null,
            });
            if (candidates.length >= limit) break;
        }
        return candidates;
    }

    recordBaseAttempt(
        base: CollectionBaseCandidate,
        _now: number,
        retryAt: number,
    ): void {
        // Keep coordinator backoff with its retained delegation, separate from
        // the bootstrap scheduler's lease/health-check timestamp.
        db.prepare(
            `UPDATE bootstrap_run_steps SET result_json=json_set(result_json,'$.${BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.BaseRetryAt}',?)
             WHERE run_id=? AND step_key=? AND json_valid(result_json)
               AND EXISTS (SELECT 1 FROM bootstrap_runs r WHERE r.run_id=bootstrap_run_steps.run_id AND r.status=?)`,
        ).run(
            retryAt,
            base.runId,
            BOOTSTRAP_STEP_KEY.Backfill,
            BOOTSTRAP_RUN_STATUS.Backfill,
        );
    }

    nextCollectionCatchup(chainId: number, now: number) {
        const rows = db
            .prepare(
                `SELECT p.collection_id AS collectionId,chain.applied_block AS chainBlock,c.status,
                    r.run_id AS runId,
                    CASE WHEN json_valid(s.result_json) THEN json_extract(s.result_json,'$.${BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.ToBlock}') END AS targetBlock
             FROM collection_sync_progress p
             JOIN chain_sync_progress chain ON chain.chain_id=p.chain_id AND chain.revision=p.revision
             JOIN collections c ON c.collection_id=p.collection_id AND c.chain_id=p.chain_id
             LEFT JOIN bootstrap_runs r ON r.chain_id=c.chain_id AND r.collection_id=c.collection_id
                 AND r.run_id=(SELECT MAX(current.run_id) FROM bootstrap_runs current WHERE current.chain_id=c.chain_id AND current.collection_id=c.collection_id)
             LEFT JOIN bootstrap_run_steps s ON s.run_id=r.run_id AND s.step_key=?
             WHERE p.chain_id=? AND p.retry_at<=? AND p.applied_block<chain.applied_block
               AND c.bootstrap_anchor_block=p.anchor_block
               AND (c.status=? OR (c.status=? AND r.status=? AND p.applied_block<
                    CASE WHEN json_valid(s.result_json) THEN json_extract(s.result_json,'$.${BOOTSTRAP_BACKFILL_STEP_RESULT_FIELD.ToBlock}') END))
             ORDER BY p.last_attempt_at,p.collection_id`,
            )
            .iterate(
                BOOTSTRAP_STEP_KEY.Backfill,
                chainId,
                now,
                COLLECTION_STATUS.Live,
                COLLECTION_STATUS.Bootstrapping,
                BOOTSTRAP_RUN_STATUS.Backfill,
            ) as Iterable<{
            collectionId: number;
            chainBlock: number;
            status: string;
            runId: number | null;
            targetBlock: number | null;
        }>;
        for (const row of rows) {
            const progress = this.progress.collectionProgress(
                chainId,
                row.collectionId,
            );
            if (!progress) continue;
            if (row.status === COLLECTION_STATUS.Live)
                return {
                    ...progress,
                    bootstrapRunId: null,
                    targetBlock: row.chainBlock,
                };
            const authority = bootstrapCatchupAuthority(
                chainId,
                row.collectionId,
            );
            if (authority)
                return {
                    ...progress,
                    bootstrapRunId: authority.runId,
                    targetBlock: Math.min(
                        row.chainBlock,
                        authority.targetBlock,
                    ),
                };
        }
        return null;
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
