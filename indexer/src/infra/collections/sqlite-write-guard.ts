import { db } from "@artgod/shared/database";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import { bootstrapCatchupAuthority } from "../bootstrap/sqlite-catchup-authority.js";
import { ChainSyncConflict } from "../../domain/chain-sync.js";
import { captureChainSyncCheckpoint } from "../storage/sqlite-chain-revisions.js";

export type CollectionWriteSnapshot = {
    chainId: number;
    collectionId: number;
    address: string;
    status: string;
    anchorBlock: number | null;
    bootstrapRunId: number | null;
    chainRevision: number;
};

/** Capture existing lifecycle identity before asynchronous enrichment. No
 * separate generation is stored: rollback revision and run identity already
 * distinguish invalidation and a fresh bootstrap at the same anchor height. */
export function captureCollectionWriteSnapshot(
    chainId: number,
    collectionId: number,
): CollectionWriteSnapshot | null {
    return db.raw.transaction(() => {
        const row = db
            .prepare(
                "SELECT c.address,c.status,c.bootstrap_anchor_block AS anchorBlock," +
                    "(SELECT MAX(r.run_id) FROM bootstrap_runs r WHERE r.chain_id=c.chain_id AND r.collection_id=c.collection_id) AS bootstrapRunId " +
                    "FROM collections c WHERE c.chain_id=? AND c.collection_id=?",
            )
            .get(chainId, collectionId) as
            | Pick<
                  CollectionWriteSnapshot,
                  "address" | "status" | "anchorBlock" | "bootstrapRunId"
              >
            | undefined;
        if (!row) return null;
        return {
            chainId,
            collectionId,
            ...row,
            chainRevision: captureChainSyncCheckpoint(chainId).revision,
        };
    })();
}

/** Ordinary enrichment may finish for an accepted paused collection or explicit
 * Backfill delegation. Prepared/ownership-only scopes require bootstrap work. */
export function permitsOrdinaryCollectionEnrichment(
    snapshot: CollectionWriteSnapshot,
): boolean {
    return (
        snapshot.status === COLLECTION_STATUS.Live ||
        snapshot.status === COLLECTION_STATUS.Paused ||
        bootstrapCatchupAuthority(snapshot.chainId, snapshot.collectionId) !==
            null
    );
}

/** The final writer rejects output fetched for an invalidated/replaced scope. */
export function assertCollectionWriteSnapshot(
    expected: CollectionWriteSnapshot,
): void {
    if (!db.raw.inTransaction)
        throw new Error("Collection output requires its writer");
    const actual = captureCollectionWriteSnapshot(
        expected.chainId,
        expected.collectionId,
    );
    if (
        !actual ||
        actual.address !== expected.address ||
        actual.status !== expected.status ||
        actual.anchorBlock !== expected.anchorBlock ||
        actual.bootstrapRunId !== expected.bootstrapRunId ||
        actual.chainRevision !== expected.chainRevision
    )
        throw new ChainSyncConflict(
            "Collection changed while its output was acquired",
        );
}
