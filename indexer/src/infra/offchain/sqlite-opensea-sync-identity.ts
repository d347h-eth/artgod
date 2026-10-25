import { db } from "@artgod/shared/database";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { BOOTSTRAP_RUN_STATUS } from "@artgod/shared/bootstrap/pipeline";
import type { OpenSeaSyncIdentity } from "../../application/offchain/opensea-orderbook-sync.js";

/** Existing run identity distinguishes a replacement even when timestamps match.
 * Run status may return to Metadata for a post-live retry; only failure revokes it. */
export function captureOpenSeaSyncIdentity(
    chainId: number,
    collectionId: number,
): OpenSeaSyncIdentity | null {
    return (
        (db
            .prepare(
                `SELECT c.chain_id AS chainId,c.collection_id AS collectionId,c.address,
                c.opensea_slug AS slug,c.bootstrap_finished_at AS bootstrapFinishedAt,
                r.run_id AS bootstrapRunId
         FROM collections c LEFT JOIN bootstrap_runs r ON r.run_id=(
             SELECT MAX(current.run_id) FROM bootstrap_runs current
             WHERE current.chain_id=c.chain_id AND current.collection_id=c.collection_id)
         WHERE c.chain_id=? AND c.collection_id=? AND c.status=?
           AND (r.run_id IS NULL OR r.status<>?)`,
            )
            .get(
                chainId,
                collectionId,
                COLLECTION_STATUS.Live,
                BOOTSTRAP_RUN_STATUS.Failed,
            ) as OpenSeaSyncIdentity | undefined) ?? null
    );
}

export function isCurrentOpenSeaSyncIdentity(
    expected: OpenSeaSyncIdentity,
): boolean {
    const current = captureOpenSeaSyncIdentity(
        expected.chainId,
        expected.collectionId,
    );
    return (
        current !== null &&
        current.address === expected.address &&
        current.slug === expected.slug &&
        current.bootstrapFinishedAt === expected.bootstrapFinishedAt &&
        current.bootstrapRunId === expected.bootstrapRunId
    );
}
