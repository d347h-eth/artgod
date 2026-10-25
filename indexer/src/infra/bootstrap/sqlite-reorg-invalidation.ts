import { db } from "@artgod/shared/database";
import { SqliteCollectionDataCleanup } from "@artgod/shared/database/collection-data-cleanup";
import {
    BOOTSTRAP_ACTIVE_RUN_STATUSES,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import { BOOTSTRAP_RUN_EVENT_CODE } from "@artgod/shared/bootstrap/run-events";
import { COLLECTION_STATUS } from "@artgod/shared/types";

export const BOOTSTRAP_REORG_FAILURE = {
    Code: "bootstrap_invalidated_by_reorg",
    Message:
        "Chain reorganization invalidated this bootstrap; start a new run.",
} as const;

const ACTIVE_RUN_SQL = BOOTSTRAP_ACTIVE_RUN_STATUSES.map(
    (status) => `'${status}'`,
).join(",");
const COLLECTION_PAGE_SIZE = 128;

/** The confirmed rollback writer owns this transition. No bootstrap snapshot
 * can veto chain recovery, and failed runs keep their diagnostic history. */
export function invalidateBootstrapCollectionsForReorg(
    chainId: number,
    fromBlock: number,
): void {
    if (!db.raw.inTransaction)
        throw new Error(
            "Bootstrap reorg invalidation requires the rollback writer",
        );
    const cleanup = new SqliteCollectionDataCleanup();
    const select = db.prepare(
        `SELECT c.collection_id AS collectionId FROM collections c WHERE c.chain_id=? AND c.collection_id>?
         AND (c.bootstrap_anchor_block>=? OR (c.status IN ('${COLLECTION_STATUS.Prepared}','${COLLECTION_STATUS.Bootstrapping}') AND EXISTS (
             SELECT 1 FROM bootstrap_runs r WHERE r.chain_id=c.chain_id AND r.collection_id=c.collection_id AND r.status IN (${ACTIVE_RUN_SQL})
         ))) ORDER BY c.collection_id LIMIT ?`,
    );
    let after = 0;
    while (true) {
        const rows = select.all(
            chainId,
            after,
            fromBlock,
            COLLECTION_PAGE_SIZE,
        ) as { collectionId: number }[];
        if (!rows.length) break;
        for (const { collectionId } of rows) {
            const input = { chainId, collectionId };
            db.prepare(
                "INSERT INTO bootstrap_run_events(run_id,chain_id,collection_id,event_code,event_level,message,payload_json) " +
                    "SELECT run_id,chain_id,collection_id,?,'error',?,? FROM bootstrap_runs WHERE chain_id=? AND collection_id=? AND status<>?",
            ).run(
                BOOTSTRAP_RUN_EVENT_CODE.RunFailed,
                BOOTSTRAP_REORG_FAILURE.Message,
                JSON.stringify({
                    code: BOOTSTRAP_REORG_FAILURE.Code,
                    rollbackFromBlock: fromBlock,
                }),
                chainId,
                collectionId,
                BOOTSTRAP_RUN_STATUS.Failed,
            );
            db.prepare(
                "UPDATE bootstrap_runs SET status=?,error_code=?,error_message=?,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE chain_id=? AND collection_id=? AND status<>?",
            ).run(
                BOOTSTRAP_RUN_STATUS.Failed,
                BOOTSTRAP_REORG_FAILURE.Code,
                BOOTSTRAP_REORG_FAILURE.Message,
                chainId,
                collectionId,
                BOOTSTRAP_RUN_STATUS.Failed,
            );
            // Revoking every unsettled lease also fences work already outside
            // SQLite. Its final write must still own the current run/step.
            db.prepare(
                "UPDATE bootstrap_run_steps SET status=?,lease_owner=NULL,lease_until=NULL,next_attempt_at=0,last_error=?,finished_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP " +
                    "WHERE run_id IN (SELECT run_id FROM bootstrap_runs WHERE chain_id=? AND collection_id=?) AND status NOT IN (?,?)",
            ).run(
                BOOTSTRAP_STEP_STATUS.FailedTerminal,
                BOOTSTRAP_REORG_FAILURE.Message,
                chainId,
                collectionId,
                BOOTSTRAP_STEP_STATUS.Succeeded,
                BOOTSTRAP_STEP_STATUS.Skipped,
            );
            cleanup.invalidateCollectionData(input);
            db.prepare(
                "UPDATE collections SET status=?,bootstrap_anchor_block=NULL,bootstrap_started_at=NULL,bootstrap_finished_at=NULL,bootstrap_last_synced_block=NULL,updated_at=CURRENT_TIMESTAMP WHERE chain_id=? AND collection_id=?",
            ).run(COLLECTION_STATUS.Prepared, chainId, collectionId);
            after = collectionId;
        }
        if (rows.length < COLLECTION_PAGE_SIZE) break;
    }
}
