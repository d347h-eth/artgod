import { db } from "@artgod/shared/database";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    BOOTSTRAP_TASK_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { SqliteBootstrapStorage } from "../../src/infra/bootstrap/sqlite.js";
import { captureChainSyncCheckpoint } from "../../src/infra/storage/sqlite-chain-revisions.js";
import type { SnapshotFinalizeInput } from "../../src/ports/bootstrap.js";

export const BOOTSTRAP_SNAPSHOT_FIXTURE_LEASE = "bootstrap-snapshot-fixture";

/** Populate the run, active claim and exact-anchor task evidence required by the
 * real installer. Ownership fixtures seed snapshot rows before calling this. */
export function prepareBootstrapSnapshotFixture(
    input: Omit<SnapshotFinalizeInput, "checkpoint" | "leaseOwner">,
): SnapshotFinalizeInput {
    db.prepare(
        "UPDATE collections SET status=?,bootstrap_anchor_block=? WHERE chain_id=? AND collection_id=?",
    ).run(
        COLLECTION_STATUS.Bootstrapping,
        input.anchorBlock,
        input.chainId,
        input.collectionId,
    );
    db.prepare(
        "INSERT INTO bootstrap_runs(run_id,chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,status,anchor_block,anchor_block_hash,anchor_block_timestamp) " +
            "VALUES (@runId,@chainId,@collectionId,'snapshot-fixture',@contract,'erc721',@metadata,@enumeration,@ownership,@anchorBlock,@anchorHash,@anchorTimestamp) " +
            "ON CONFLICT(run_id) DO UPDATE SET chain_id=excluded.chain_id,collection_id=excluded.collection_id,request_address=excluded.request_address,status=excluded.status,anchor_block=excluded.anchor_block,anchor_block_hash=excluded.anchor_block_hash,anchor_block_timestamp=excluded.anchor_block_timestamp",
    ).run({
        ...input,
        metadata: BOOTSTRAP_METADATA_MODE.Strict,
        enumeration: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
        ownership: BOOTSTRAP_RUN_STATUS.Ownership,
    });
    db.prepare(
        "INSERT INTO bootstrap_run_steps(run_id,step_key,status,lease_owner,lease_until) VALUES (?,?,?,?,?) " +
            "ON CONFLICT(run_id,step_key) DO UPDATE SET status=excluded.status,lease_owner=excluded.lease_owner,lease_until=excluded.lease_until",
    ).run(
        input.runId,
        BOOTSTRAP_STEP_KEY.Ownership,
        BOOTSTRAP_STEP_STATUS.Running,
        BOOTSTRAP_SNAPSHOT_FIXTURE_LEASE,
        Date.now() + 60_000,
    );
    db.prepare(
        "DELETE FROM bootstrap_ownership_snapshot_tasks WHERE run_id=?",
    ).run(input.runId);
    db.prepare(
        "INSERT INTO bootstrap_ownership_snapshot_tasks(run_id,chain_id,collection_id,contract_address,token_id,standard,anchor_block,anchor_block_hash,anchor_block_timestamp,status) " +
            "SELECT run_id,chain_id,collection_id,contract_address,token_id,'erc721',anchor_block,@anchorHash,@anchorTimestamp,@succeeded FROM nft_balance_snapshots WHERE run_id=@runId",
    ).run({
        runId: input.runId,
        anchorHash: input.anchorHash,
        anchorTimestamp: input.anchorTimestamp,
        succeeded: BOOTSTRAP_TASK_STATUS.Succeeded,
    });
    return {
        ...input,
        checkpoint: captureChainSyncCheckpoint(input.chainId),
        leaseOwner: BOOTSTRAP_SNAPSHOT_FIXTURE_LEASE,
    };
}

export function finalizeBootstrapSnapshotFixture(
    storage: SqliteBootstrapStorage,
    input: Omit<SnapshotFinalizeInput, "checkpoint" | "leaseOwner">,
): void {
    const collection = db
        .prepare(
            "SELECT status FROM collections WHERE chain_id=? AND collection_id=?",
        )
        .get(input.chainId, input.collectionId) as { status: string };
    storage.finalizeSnapshot(prepareBootstrapSnapshotFixture(input));
    db.prepare(
        "UPDATE collections SET status=? WHERE chain_id=? AND collection_id=?",
    ).run(collection.status, input.chainId, input.collectionId);
}
