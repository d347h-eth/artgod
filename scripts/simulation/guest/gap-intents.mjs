import assert from "node:assert/strict";
import { COLLECTION_STATUS } from "../../../shared/types/browse.ts";
import { assertSimulationProperty } from "./oracle-assertions.mjs";

export const GAP_INTENT_PROPERTY = "settled-due-gap-repair-intents";
export const GAP_INTENT_DEFERRED = Object.freeze({
    Inactive: "collection-not-live",
    AnchorChanged: "bootstrap-anchor-changed",
    AnchorAhead: "bootstrap-anchor-ahead-of-head",
    Immature: "inside-reorg-window",
    Retry: "retry-scheduled",
});

/** Read logical SQLite repair intents, which are not retained NATS messages. */
export function observeGapRepairIntents(database, chainId, collectionId) {
    return database
        .prepare(
            "SELECT s.chain_id,s.collection_id,s.anchor_block,s.cursor_block,s.pending_job_id,s.pending_from_block,s.pending_to_block,s.retry_at,c.status AS collection_status,c.bootstrap_anchor_block AS current_anchor_block FROM collection_sync_gap_scans s JOIN collections c ON c.chain_id=s.chain_id AND c.collection_id=s.collection_id WHERE s.chain_id=? AND s.collection_id=? ORDER BY s.collection_id",
        )
        .all(chainId, collectionId);
}

const nonnegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

/** Independently classify the observed scheduling boundary. Deferred intents
 * remain explicit evidence; their presence does not prove another RPC fetch. */
export function inspectGapRepairIntents({ rows, head, reorgDepth, now }) {
    assert.ok(Array.isArray(rows), "Gap-intent observation must be explicit");
    assert.ok(nonnegativeInteger(head));
    assert.ok(nonnegativeInteger(reorgDepth) && reorgDepth > 0);
    assert.ok(nonnegativeInteger(now));
    const eligibleUpperBound = Math.max(0, head - reorgDepth);
    const due = [];
    const deferred = [];
    const idle = [];
    for (const row of rows) {
        assert.ok(nonnegativeInteger(row.chain_id) && row.chain_id > 0);
        assert.ok(
            nonnegativeInteger(row.collection_id) && row.collection_id > 0,
        );
        assert.ok(nonnegativeInteger(row.anchor_block) && row.anchor_block > 0);
        assert.ok(
            row.current_anchor_block === null ||
                (nonnegativeInteger(row.current_anchor_block) &&
                    row.current_anchor_block > 0),
            "The current bootstrap anchor must be explicitly observed",
        );
        assert.ok(
            row.cursor_block === null ||
                (nonnegativeInteger(row.cursor_block) &&
                    row.cursor_block >= row.anchor_block),
        );
        assert.ok(
            Object.values(COLLECTION_STATUS).includes(row.collection_status),
        );
        if (row.pending_job_id === null) {
            assert.equal(row.pending_from_block, null);
            assert.equal(row.pending_to_block, null);
            assert.equal(row.retry_at, null);
            idle.push(row);
            continue;
        }
        assert.ok(typeof row.pending_job_id === "string" && row.pending_job_id);
        assert.ok(
            nonnegativeInteger(row.pending_from_block) &&
                row.pending_from_block >= row.anchor_block,
        );
        assert.ok(
            nonnegativeInteger(row.pending_to_block) &&
                row.pending_to_block >= row.pending_from_block,
        );
        assert.ok(nonnegativeInteger(row.retry_at));
        const reason =
            row.collection_status !== COLLECTION_STATUS.Live
                ? GAP_INTENT_DEFERRED.Inactive
                : row.current_anchor_block !== row.anchor_block
                  ? GAP_INTENT_DEFERRED.AnchorChanged
                  : row.anchor_block > head
                    ? GAP_INTENT_DEFERRED.AnchorAhead
                    : row.pending_to_block > eligibleUpperBound
                      ? GAP_INTENT_DEFERRED.Immature
                      : row.retry_at > now
                        ? GAP_INTENT_DEFERRED.Retry
                        : null;
        if (reason) deferred.push({ reason, intent: row });
        else due.push(row);
    }
    return { head, reorgDepth, now, eligibleUpperBound, due, deferred, idle };
}

/** Only due eligible work is a convergence obligation at this fixed cut.
 * A future retry is reported rather than credited as completed work. */
export function assertGapRepairIntentsSettled(inspection) {
    assertSimulationProperty(GAP_INTENT_PROPERTY, () =>
        assert.deepEqual(
            inspection.due,
            [],
            "The fixed endpoint still has due eligible collection repair intent",
        ),
    );
}
