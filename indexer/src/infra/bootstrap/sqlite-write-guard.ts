import { db } from "@artgod/shared/database";
import { BOOTSTRAP_RUN_STATUS } from "@artgod/shared/bootstrap/pipeline";
import { ChainSyncConflict } from "../../domain/chain-sync.js";

/** Check inside the output writer, after any RPC, so failed or replaced runs
 * cannot recreate data removed by authoritative recovery. Completed runs may
 * still own eventual image/extension/OpenSea side steps. */
export function isBootstrapRunWritable(
    runId: number,
    scope?: { chainId: number; collectionId: number },
): boolean {
    const row = db
        .prepare(
            "SELECT r.chain_id AS chainId,r.collection_id AS collectionId FROM bootstrap_runs r JOIN collections c ON c.chain_id=r.chain_id AND c.collection_id=r.collection_id " +
                "WHERE r.run_id=? AND r.status<>? AND NOT EXISTS (SELECT 1 FROM bootstrap_runs newer WHERE newer.chain_id=r.chain_id AND newer.collection_id=r.collection_id AND newer.run_id>r.run_id)",
        )
        .get(runId, BOOTSTRAP_RUN_STATUS.Failed) as
        | { chainId: number; collectionId: number }
        | undefined;
    return (
        !!row &&
        (!scope ||
            (row.chainId === scope.chainId &&
                row.collectionId === scope.collectionId))
    );
}

export function assertBootstrapRunWritable(
    runId: number,
    scope?: { chainId: number; collectionId: number },
): void {
    if (!isBootstrapRunWritable(runId, scope))
        throw new ChainSyncConflict("Bootstrap run no longer owns its output");
}
