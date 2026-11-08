import assert from "node:assert/strict";
import {
    ORDER_STATUS,
    ORDER_SOURCE_STATUS,
} from "../../../shared/market-data/orders.ts";

export const SIMULATION_PROPERTY = Object.freeze({
    CollectionCoverage: "canonical-collection-coverage",
    CanonicalHeaders: "canonical-stored-headers",
    SellValidation: "current-sell-validation",
    BuyValidation: "current-buy-validation",
});

function property(name, assertion) {
    try {
        assertion();
    } catch (error) {
        error.property = name;
        throw error;
    }
}

/** Expected coverage and headers come from the independent external chain ledger. */
export function assertCanonicalAcquisition({ snapshot, ledger, branch, head }) {
    const heights = Array.from(
        { length: head - ledger.anchorBlock },
        (_, index) => ledger.anchorBlock + index + 1,
    );
    property(SIMULATION_PROPERTY.CollectionCoverage, () => {
        assert.deepEqual(
            snapshot.coverage
                .map((row) => row.block_number)
                .filter((number) => number > ledger.anchorBlock),
            heights,
            "The tested collection must cover every post-anchor block through its winning head exactly once",
        );
    });
    property(SIMULATION_PROPERTY.CanonicalHeaders, () => {
        const actual = snapshot.headers.filter(
            (row) => row.block_number > ledger.anchorBlock,
        );
        assert.deepEqual(
            actual.map((row) => row.block_number),
            heights,
            "Stored post-anchor headers must cover the declared final head",
        );
        for (const row of actual) {
            const expected = ledger.blockAt(branch, row.block_number);
            assert.equal(
                row.block_hash,
                expected.hash,
                `Canonical hash at block ${row.block_number}`,
            );
            assert.equal(
                row.parent_hash,
                expected.parentHash,
                `Canonical parent at block ${row.block_number}`,
            );
        }
    });
}

/** Active orders need a current full proof; source cancellation is independent. */
export function assertMarketConvergence({
    snapshot,
    ledger,
    expectedSourceStatuses = {},
}) {
    for (const [name, order] of Object.entries(ledger.orders)) {
        property(
            name === "bid"
                ? SIMULATION_PROPERTY.BuyValidation
                : SIMULATION_PROPERTY.SellValidation,
            () => {
                const actual = snapshot.orders.find(
                    (row) => row.id === order.orderHash,
                );
                assert.ok(
                    actual,
                    `Current ${name} observation must be admitted`,
                );
                const expectedSource =
                    expectedSourceStatuses[order.orderHash] ??
                    ORDER_SOURCE_STATUS.Active;
                assert.equal(
                    actual.source_status,
                    expectedSource,
                    `Current ${name} must retain the declared source evidence`,
                );
                // Source cancellation makes an order non-actionable without
                // changing its independent onchain fillability or requiring a
                // new RPC proof for that cancelled source observation.
                if (expectedSource !== ORDER_SOURCE_STATUS.Active) return;
                assert.equal(
                    actual.fillability_status,
                    ORDER_STATUS.Fillable,
                    `Current ${name} must be executable on the independent world branch`,
                );
                assert.ok(
                    actual.validated_at > 0,
                    `Current ${name} needs a full validation checkpoint`,
                );
                const proof = snapshot.validationProofs.find(
                    (row) => row.order_id === order.orderHash,
                );
                assert.ok(
                    proof,
                    `Current ${name} must retain validation evidence`,
                );
                assert.equal(
                    proof.pending,
                    0,
                    `Current ${name} demand must be settled`,
                );
                assert.equal(
                    proof.proof_chain_revision,
                    snapshot.revision,
                    `Current ${name} cannot reuse an orphan-fork validation proof`,
                );
            },
        );
    }
}
