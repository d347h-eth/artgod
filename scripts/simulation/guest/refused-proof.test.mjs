import assert from "node:assert/strict";
import test from "node:test";
import { verifyRefusedProof } from "./refused-proof.mjs";
import { REORG_RECOVERY_PHASE } from "../../../indexer/src/domain/reorg-recovery.ts";

// Oracle guards only. Actual acquisition/proof/refusal requires the authored VM.
function fixture({ deleteHistory = false } = {}) {
    const ledger = {
        anchorBlock: 100,
        forkBlock: 103,
        blockAt: (branch, number) => ({
            hash: `${branch}:${number}`,
            parentHash: `${branch}:${number - 1}`,
        }),
    };
    const before = {
        revision: 0,
        recovery: [],
        canonicalChecks: [],
        pendingDemand: [],
        unfinishedMaker: [],
        pendingOutbox: [],
        owners: [{ token_id: "1", owner: "retained-owner" }],
        transfers: [{ block_number: 101, token_id: "1" }],
        activities: [{ kind: "transfer", block_number: 101, token_id: "1" }],
        coverage: Array.from({ length: 8 }, (_, i) => ({
            block_number: 101 + i,
        })),
        headers: Array.from({ length: 8 }, (_, i) => ({
            block_number: 101 + i,
            block_hash: `A:${101 + i}`,
            parent_hash: `A:${100 + i}`,
        })),
    };
    const after = structuredClone(before);
    if (deleteHistory) after.activities = [];
    // This reproduces the observed framework counterexample: independently
    // queued legitimate A projection commits after acquisition/proof settles.
    after.activities.push({ kind: "sale", block_number: 104, token_id: "1" });
    after.recovery.push({
        phase: REORG_RECOVERY_PHASE.AwaitingAncestor,
        checked_block: 107,
        last_error: "No verified common ancestor",
        retry_at: Date.now() + 60_000,
    });
    let switched = false;
    const world = {
        trace: [],
        setPhase() {},
        advanceHead() {},
        switchBranch() {
            switched = true;
            this.trace = [104, 105, 106, 107].map((blockNumber) => ({
                type: "read",
                phase: "refusal-requested-b",
                method: "eth_getBlockByNumber",
                blockNumber,
                view: { branch: "B" },
            }));
        },
    };
    return {
        world,
        ledger,
        observe: () => (switched ? after : before),
        reorgDepth: 3,
        async closeSources() {},
        async eventually(predicate, label) {
            assert.equal(await predicate(), true, label);
        },
    };
}

test("refused ancestry preserves retained facts while legitimate old-branch history may finish", async () => {
    const result = await verifyRefusedProof(fixture());
    assert.equal(result.endpoint, "awaiting-verified-ancestor");
    assert.equal(
        result.after.activities.length,
        result.before.activities.length + 1,
    );
    assert.equal(result.after.revision, result.before.revision);
});

test("additional history never hides deletion of an already retained fact", async () => {
    await assert.rejects(
        verifyRefusedProof(fixture({ deleteHistory: true })),
        /cannot delete retained history/,
    );
});
