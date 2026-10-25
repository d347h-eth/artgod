import { db } from "@artgod/shared/database";
import {
    MAKER_REVALIDATION_POLICY,
    MAKER_REVALIDATION_STATUS,
    canonicalMakerRequest,
    makerValidationScopeKey,
} from "../../domain/maker-revalidation.js";
import { ChainSyncConflict } from "../../domain/chain-sync.js";
import type { OrderUpdateByMakerPayload } from "../../domain/order-jobs.js";
import { assertChainSyncCheckpoint } from "../storage/sqlite-chain-revisions.js";

/** The rollback writer transfers scope obligations before rebinding any proof.
 * A coalesced maximum does not retain the earlier event heights it superseded.
 * Cap orphaned requirements at the verified ancestor instead of dropping those
 * potentially surviving invalidations. This can conservatively revalidate a
 * scope whose events were all orphaned; it never reconstructs event facts. */
export function reconcileMakerRevalidationsAfterRollback(input: {
    chainId: number;
    fromBlock: number;
    previousRevision: number;
    newRevision: number;
    now: number;
}): void {
    const { chainId, fromBlock, previousRevision, newRevision, now } = input;
    assertChainSyncCheckpoint({ chainId, revision: newRevision });
    // Storage retains this exact verified ancestor before advancing the revision.
    const ancestor = db
        .prepare(
            "SELECT block_hash AS hash FROM blocks WHERE chain_id=? AND block_number=?",
        )
        .get(chainId, fromBlock - 1) as { hash: string } | undefined;
    if (!ancestor)
        throw new ChainSyncConflict(
            "Maker rollback requires the retained ancestor",
        );
    const select = db.prepare(
        "SELECT run_id AS runId,payload_json AS payloadJson,requested_payload_json AS requestedPayloadJson FROM maker_order_revalidation_runs " +
            "WHERE chain_id=? AND status=? AND required_chain_revision=? AND required_block_number IS NOT NULL AND run_id>? ORDER BY run_id LIMIT ?",
    );
    const header = db.prepare(
        "SELECT 1 FROM blocks WHERE chain_id=? AND block_number=? AND block_hash=?",
    );
    const survives = (payload: OrderUpdateByMakerPayload): boolean =>
        payload.blockNumber != null &&
        payload.blockNumber < fromBlock &&
        !!header.get(chainId, payload.blockNumber, payload.blockHash);
    let afterId = "";
    while (true) {
        // Close the bounded reader before updating this same connection.
        const rows = select.all(
            chainId,
            MAKER_REVALIDATION_STATUS.Pending,
            previousRevision,
            afterId,
            MAKER_REVALIDATION_POLICY.batchOrders,
        ) as Array<{
            runId: string;
            payloadJson: string;
            requestedPayloadJson: string;
        }>;
        if (!rows.length) return;
        for (const row of rows) {
            const current = JSON.parse(
                row.payloadJson,
            ) as OrderUpdateByMakerPayload;
            const requested = JSON.parse(
                row.requestedPayloadJson,
            ) as OrderUpdateByMakerPayload;
            const ancestorRequirement = canonicalMakerRequest({
                ...current,
                blockNumber: fromBlock - 1,
                blockHash: ancestor.hash,
                txHash: null,
                logIndex: null,
            });
            if (!survives(current)) {
                // Earlier expanded orders already have their orphaned demand
                // reconciled by the rollback writer. Keep this finite pass's
                // cursor for the remaining orders, now requiring the ancestor.
                db.prepare(
                    "UPDATE maker_order_revalidation_runs SET payload_json=?,requested_payload_json=?,required_block_number=?,required_block_hash=?,pass_generation=generation WHERE run_id=?",
                ).run(
                    JSON.stringify(ancestorRequirement),
                    JSON.stringify(ancestorRequirement),
                    ancestorRequirement.blockNumber,
                    ancestorRequirement.blockHash,
                    row.runId,
                );
            } else if (!survives(requested)) {
                // Preserve a full follow-up for any surviving interval beyond
                // the current requirement: an intermediate event may have been
                // coalesced into the now-orphaned requested maximum.
                const requirement =
                    current.blockNumber === ancestorRequirement.blockNumber
                        ? current
                        : ancestorRequirement;
                db.prepare(
                    "UPDATE maker_order_revalidation_runs SET requested_payload_json=?,required_block_number=?,required_block_hash=?,pass_generation=CASE WHEN ? THEN generation ELSE pass_generation END WHERE run_id=?",
                ).run(
                    JSON.stringify(requirement),
                    requirement.blockNumber,
                    requirement.blockHash,
                    current.blockNumber === ancestorRequirement.blockNumber
                        ? 1
                        : 0,
                    row.runId,
                );
            }
            db.prepare(
                "UPDATE maker_order_revalidation_runs SET required_chain_revision=?,scope_key=?,lease_owner=NULL,lease_until=0,lease_version=lease_version+1,updated_at=? WHERE run_id=?",
            ).run(
                newRevision,
                makerValidationScopeKey(current, newRevision),
                now,
                row.runId,
            );
        }
        afterId = rows.at(-1)!.runId;
    }
}
