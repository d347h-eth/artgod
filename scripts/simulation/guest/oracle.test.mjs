import assert from "node:assert/strict";
import test from "node:test";
import {
    ORDER_STATUS,
    ORDER_SOURCE_STATUS,
} from "../../../shared/market-data/orders.ts";
import {
    assertCanonicalAcquisition,
    assertMarketConvergence,
    SIMULATION_PROPERTY,
} from "./oracle.mjs";

const ledger = {
    anchorBlock: 100,
    orders: { listing: { orderHash: "listing" }, bid: { orderHash: "bid" } },
    blockAt(branch, number) {
        return {
            hash: `${branch}:${number}`,
            parentHash: `${branch}:${number - 1}`,
        };
    },
};
const snapshot = () => ({
    revision: 2,
    coverage: [
        { block_number: 100 },
        { block_number: 101 },
        { block_number: 102 },
    ],
    headers: [101, 102].map((number) => ({
        block_number: number,
        block_hash: `B:${number}`,
        parent_hash: `B:${number - 1}`,
    })),
    orders: ["listing", "bid"].map((id) => ({
        id,
        source_status: ORDER_SOURCE_STATUS.Active,
        fillability_status: ORDER_STATUS.Fillable,
        validated_at: 123,
    })),
    validationProofs: ["listing", "bid"].map((order_id) => ({
        order_id,
        pending: 0,
        proof_chain_revision: 2,
    })),
});

test("the chain oracle rejects a coverage hole even when current ownership and recovery look settled", () => {
    const actual = snapshot();
    actual.coverage.splice(1, 1);
    assert.throws(
        () =>
            assertCanonicalAcquisition({
                snapshot: actual,
                ledger,
                branch: "B",
                head: 102,
            }),
        { property: SIMULATION_PROPERTY.CollectionCoverage },
    );
});
test("the chain oracle rejects a retained orphan header and its wrong parent", () => {
    const actual = snapshot();
    actual.headers[1].block_hash = "A:102";
    assert.throws(
        () =>
            assertCanonicalAcquisition({
                snapshot: actual,
                ledger,
                branch: "B",
                head: 102,
            }),
        { property: SIMULATION_PROPERTY.CanonicalHeaders },
    );
});
test("the market oracle detects an orphan-derived buy outcome while the sell ask is correct", () => {
    const actual = snapshot();
    actual.orders[1].fillability_status = ORDER_STATUS.Invalid;
    assert.throws(() => assertMarketConvergence({ snapshot: actual, ledger }), {
        property: SIMULATION_PROPERTY.BuyValidation,
    });
});
test("the market oracle rejects old-fork proof reuse even when both order statuses look correct", () => {
    const actual = snapshot();
    actual.validationProofs[1].proof_chain_revision = 1;
    assert.throws(() => assertMarketConvergence({ snapshot: actual, ledger }), {
        property: SIMULATION_PROPERTY.BuyValidation,
    });
});
test("the independent world, source statuses and current proof agree at the supported endpoint", () => {
    const actual = snapshot();
    assertCanonicalAcquisition({
        snapshot: actual,
        ledger,
        branch: "B",
        head: 102,
    });
    assertMarketConvergence({ snapshot: actual, ledger });
});

test("source cancellation is authoritative without rewriting independent protocol state or demanding a fresh proof", () => {
    const actual = snapshot();
    actual.orders[1].source_status = ORDER_SOURCE_STATUS.Cancelled;
    actual.validationProofs[1].proof_chain_revision = 1;
    assertMarketConvergence({
        snapshot: actual,
        ledger,
        expectedSourceStatuses: { bid: ORDER_SOURCE_STATUS.Cancelled },
    });
    actual.orders[1].source_status = ORDER_SOURCE_STATUS.Active;
    assert.throws(
        () =>
            assertMarketConvergence({
                snapshot: actual,
                ledger,
                expectedSourceStatuses: { bid: ORDER_SOURCE_STATUS.Cancelled },
            }),
        { property: SIMULATION_PROPERTY.BuyValidation },
    );
});
