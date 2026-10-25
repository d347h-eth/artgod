import { db } from "@artgod/shared/database";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import { parseBootstrapBackfillDelegatedRange } from "../../application/bootstrap-backfill-executor.js";

export type BootstrapCatchupAuthority = {
    runId: number;
    anchorBlock: number;
    anchorHash: string;
    targetBlock: number;
};

// Backfill's retained range is the handover. The ownership step may install its
// snapshot earlier, but that never authorizes the ordinary sync worker.
export function bootstrapCatchupAuthority(
    chainId: number,
    collectionId: number,
): BootstrapCatchupAuthority | null {
    const row = db
        .prepare(
            `SELECT r.run_id AS runId,r.anchor_block AS anchorBlock,
                r.anchor_block_hash AS anchorHash,s.result_json AS resultJson
         FROM bootstrap_runs r
         JOIN collections c ON c.chain_id=r.chain_id AND c.collection_id=r.collection_id
         JOIN bootstrap_run_steps s ON s.run_id=r.run_id AND s.step_key=?
         JOIN bootstrap_run_steps ownership ON ownership.run_id=r.run_id AND ownership.step_key=?
         WHERE r.chain_id=? AND r.collection_id=? AND c.status=? AND r.status=?
           AND c.bootstrap_anchor_block=r.anchor_block AND ownership.status=?
           AND s.status IN (?,?,?,?,?)
           AND r.run_id=(SELECT MAX(current.run_id) FROM bootstrap_runs current
                         WHERE current.chain_id=r.chain_id AND current.collection_id=r.collection_id)`,
        )
        .get(
            BOOTSTRAP_STEP_KEY.Backfill,
            BOOTSTRAP_STEP_KEY.Ownership,
            chainId,
            collectionId,
            COLLECTION_STATUS.Bootstrapping,
            BOOTSTRAP_RUN_STATUS.Backfill,
            BOOTSTRAP_STEP_STATUS.Succeeded,
            BOOTSTRAP_STEP_STATUS.Ready,
            BOOTSTRAP_STEP_STATUS.FailedRetry,
            BOOTSTRAP_STEP_STATUS.Running,
            BOOTSTRAP_STEP_STATUS.Succeeded,
            BOOTSTRAP_STEP_STATUS.Skipped,
        ) as
        | {
              runId: number;
              anchorBlock: number;
              anchorHash: string;
              resultJson: string | null;
          }
        | undefined;
    if (!row || !row.anchorHash) return null;
    const range = parseBootstrapBackfillDelegatedRange(row.resultJson);
    if (
        !range ||
        range.fromBlock !== row.anchorBlock + 1 ||
        range.toBlock < row.anchorBlock
    )
        return null;
    return {
        runId: row.runId,
        anchorBlock: row.anchorBlock,
        anchorHash: row.anchorHash,
        targetBlock: range.toBlock,
    };
}
