import assert from "node:assert/strict";
import { REORG_RECOVERY_PHASE } from "../../../indexer/src/domain/reorg-recovery.ts";
import { assertCanonicalAcquisition } from "./oracle.mjs";

/** Unsupported deep-fork endpoint: retain work, never invent an ancestor/rollback. */
export async function verifyRefusedProof({
    world,
    ledger,
    observe,
    eventually,
    closeSources,
    reorgDepth,
}) {
    await closeSources();
    const acquiredHead = 108;
    const replacementHead = 110;
    assert.equal(
        ledger.forkBlock,
        103,
        "This bounded refusal fixture declares its common prefix explicitly",
    );
    world.setPhase("refusal-retained-a");
    world.advanceHead(acquiredHead);
    await eventually(
        () => {
            const state = observe();
            return (
                state.coverage.filter(
                    (row) =>
                        row.block_number > ledger.anchorBlock &&
                        row.block_number <= acquiredHead,
                ).length ===
                    acquiredHead - ledger.anchorBlock &&
                state.canonicalChecks.every(
                    (row) => row.block_number > acquiredHead - reorgDepth + 1,
                ) &&
                state.recovery.length === 0
            );
        },
        "actual A history acquisition and all mature A checks before the deep fork",
        120_000,
    );
    const before = observe();
    assertCanonicalAcquisition({
        snapshot: before,
        ledger,
        branch: "A",
        head: acquiredHead,
    });
    world.setPhase("refusal-requested-b");
    world.switchBranch("B", { head: replacementHead });
    let after;
    await eventually(
        () => {
            const state = observe();
            const recovery = state.recovery.find(
                (row) =>
                    row.phase === REORG_RECOVERY_PHASE.AwaitingAncestor &&
                    row.checked_block >= 107 &&
                    row.last_error &&
                    row.retry_at > Date.now(),
            );
            if (!recovery) return false;
            const from = recovery.checked_block - reorgDepth;
            const heights = Array.from(
                { length: reorgDepth + 1 },
                (_, index) => from + index,
            );
            if (
                !heights.every((number) =>
                    world.trace.some(
                        (entry) =>
                            entry.type === "read" &&
                            entry.phase === "refusal-requested-b" &&
                            entry.method === "eth_getBlockByNumber" &&
                            entry.blockNumber === number &&
                            entry.view.branch === "B",
                    ),
                )
            )
                return false;
            after = state;
            return true;
        },
        "actual complete bounded B proof attempt retained without a matching ancestor",
        120_000,
    );
    assert.equal(
        after.revision,
        before.revision,
        "Unproved ancestry cannot advance the chain revision",
    );
    assert.deepEqual(
        after.owners,
        before.owners,
        "Unsupported recovery cannot overwrite retained ownership",
    );
    assert.deepEqual(
        after.transfers.filter((row) => row.block_number <= acquiredHead),
        before.transfers,
        "Unsupported recovery cannot delete retained transfer facts",
    );
    // Activity projection runs independently of acquisition. A legitimate A
    // job may append history after the retained snapshot; existing facts must
    // survive the unsupported fork, without requiring those queues to stop.
    const retainedHistory = after.activities.filter(
        (row) => row.block_number <= acquiredHead,
    );
    for (const retained of before.activities) {
        const index = retainedHistory.findIndex(
            (row) => JSON.stringify(row) === JSON.stringify(retained),
        );
        assert.ok(
            index >= 0,
            "Unsupported recovery cannot delete retained history",
        );
        retainedHistory.splice(index, 1);
    }
    assert.deepEqual(
        after.headers.filter((row) => row.block_number <= acquiredHead),
        before.headers,
        "Unsupported recovery cannot replace retained fork headers",
    );
    return {
        endpoint: "awaiting-verified-ancestor",
        requestedBranch: "B",
        retainedBranch: "A",
        acquiredHead,
        replacementHead,
        commonPrefix: ledger.forkBlock,
        before,
        after,
        pendingObligations: {
            recovery: after.recovery,
            canonicalChecks: after.canonicalChecks,
            validation: after.pendingDemand,
            maker: after.unfinishedMaker,
            outbox: after.pendingOutbox,
        },
    };
}
