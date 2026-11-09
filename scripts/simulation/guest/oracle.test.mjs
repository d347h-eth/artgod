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
import { createBaselineLedger } from "../world/ledger.mjs";
import { ZERO_ADDRESS } from "../world/wire.mjs";
import { COLLECTION_STANDARD } from "../../../shared/types/browse.ts";
import { baselineFillFacts } from "./fixtures/fill-facts.mjs";

const ledger = createBaselineLedger({ epochSeconds: 1_000_000 });
// Reviewed fixture truth table: two mints and one A-only transfer. This does not
// invoke the oracle's decoder or the product's acquisition/ownership reducers.
const transfer = (branch, number, tokenId, from, to) => {
    const block = ledger.blockAt(branch, number);
    const log = block.logs[0];
    return {
        chain_id: ledger.chainId,
        collection_id: 42,
        contract_address: ledger.addresses.nft,
        from_address: from,
        to_address: to,
        token_id: tokenId,
        amount: "1",
        block_number: number,
        block_hash: block.hash,
        block_timestamp: block.timestamp,
        tx_hash: log.transactionHash,
        log_index: 0,
        kind: COLLECTION_STANDARD.Erc721,
    };
};
const snapshot = ({ branch = "B", head = 102 } = {}) => ({
    ...baselineFillFacts(ledger, { branch, head }),
    revision: 2,
    coverage: Array.from({ length: head - 99 }, (_, index) => ({
        block_number: 100 + index,
    })),
    headers: Array.from({ length: head - 100 }, (_, index) => {
        const number = 101 + index;
        const block = ledger.blockAt(branch, number);
        return {
            block_number: number,
            block_hash: block.hash,
            parent_hash: block.parentHash,
        };
    }),
    owners: ["1", "2"].map((tokenId) => ({
        token_id: tokenId,
        owner:
            branch === "A" && head >= 104 && tokenId === "1"
                ? ledger.addresses.buyer
                : ledger.addresses.seller,
        amount: "1",
        last_block_number:
            branch === "A" && head >= 104 && tokenId === "1"
                ? 104
                : 100 + Number(tokenId),
    })),
    transfers: [
        transfer(branch, 101, "1", ZERO_ADDRESS, ledger.addresses.seller),
        transfer(branch, 102, "2", ZERO_ADDRESS, ledger.addresses.seller),
        ...(branch === "A" && head >= 104
            ? [
                  transfer(
                      "A",
                      104,
                      "1",
                      ledger.addresses.seller,
                      ledger.addresses.buyer,
                  ),
              ]
            : []),
    ],
    orders: Object.values(ledger.orders).map((order) => ({
        id: order.orderHash,
        source_status: ORDER_SOURCE_STATUS.Active,
        fillability_status: ORDER_STATUS.Fillable,
        validated_at: 123,
        state_revision: 3,
    })),
    validationProofs: Object.values(ledger.orders).map((order) => ({
        order_id: order.orderHash,
        pending: 0,
        required_at: 120_000,
        minimum_block: 102,
        proof_revision: 3,
        proof_at: 123_000,
        proof_block: 102,
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
test("stored older-chain coverage remains legal without a new current-chain obligation", () => {
    const actual = snapshot();
    actual.validationProofs[1].proof_chain_revision = 1;
    assertMarketConvergence({ snapshot: actual, ledger });
});

test("future-chain and absent proof evidence cannot qualify a settled current order", () => {
    for (const mutate of [
        (actual) => {
            actual.validationProofs[1].proof_chain_revision =
                actual.revision + 1;
        },
        (actual) => {
            actual.validationProofs = actual.validationProofs.filter(
                (row) => row.order_id !== ledger.orders.bid.orderHash,
            );
        },
    ]) {
        const actual = snapshot();
        mutate(actual);
        assert.throws(
            () => assertMarketConvergence({ snapshot: actual, ledger }),
            { property: SIMULATION_PROPERTY.BuyValidation },
        );
    }
});

test("settled current-chain proof cannot reuse an older canonical source revision", () => {
    for (const mutate of [
        (actual) => {
            actual.validationProofs[1].proof_revision--;
        },
        (actual) => {
            actual.orders[1].state_revision++;
        },
    ]) {
        const actual = snapshot();
        mutate(actual);
        assert.throws(
            () => assertMarketConvergence({ snapshot: actual, ledger }),
            {
                property: SIMULATION_PROPERTY.BuyValidation,
            },
        );
    }
});
test("settled proof must cover the real retained source timestamp and event block", () => {
    for (const mutate of [
        (proof) => {
            proof.proof_at = proof.required_at - 1;
        },
        (proof) => {
            proof.proof_block = proof.minimum_block - 1;
        },
        (proof) => {
            proof.required_at = proof.proof_at + 1;
        },
        (proof) => {
            proof.minimum_block = proof.proof_block + 1;
        },
    ]) {
        const actual = snapshot();
        mutate(actual.validationProofs[1]);
        assert.throws(
            () => assertMarketConvergence({ snapshot: actual, ledger }),
            {
                property: SIMULATION_PROPERTY.BuyValidation,
            },
        );
    }
});
test("missing requirements and malformed SQLite proof evidence fail explicitly", () => {
    for (const field of [
        "required_at",
        "minimum_block",
        "proof_revision",
        "proof_at",
        "proof_block",
        "proof_chain_revision",
    ]) {
        const actual = snapshot();
        delete actual.validationProofs[1][field];
        assert.throws(
            () => assertMarketConvergence({ snapshot: actual, ledger }),
            {
                property: SIMULATION_PROPERTY.BuyValidation,
            },
            field,
        );
    }
    for (const [field, value] of [
        ["required_at", null],
        ["required_at", "120000"],
        ["required_at", -1],
        ["minimum_block", "102"],
        ["minimum_block", -1],
        ["minimum_block", 1.5],
        ["proof_at", null],
        ["proof_at", "123000"],
        ["proof_block", null],
        ["proof_block", "102"],
        ["proof_revision", null],
        ["proof_chain_revision", null],
    ]) {
        const actual = snapshot();
        actual.validationProofs[1][field] = value;
        assert.throws(
            () => assertMarketConvergence({ snapshot: actual, ledger }),
            {
                property: SIMULATION_PROPERTY.BuyValidation,
            },
            `${field}=${value}`,
        );
    }
    for (const target of ["order", "chain"]) {
        const actual = snapshot();
        if (target === "order") delete actual.orders[1].state_revision;
        else delete actual.revision;
        assert.throws(() =>
            assertMarketConvergence({ snapshot: actual, ledger }),
        );
    }
});
test("exact coverage, zero requirements and a null block floor retain owning contract semantics", () => {
    for (const mutate of [
        (proof) => {
            proof.proof_at = proof.required_at;
            proof.proof_block = proof.minimum_block;
        },
        (proof) => {
            proof.required_at = 0;
            proof.minimum_block = 0;
        },
        (proof) => {
            proof.minimum_block = null;
        },
    ]) {
        const actual = snapshot({ head: 107 });
        mutate(actual.validationProofs[1]);
        assertMarketConvergence({ snapshot: actual, ledger });
    }
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
        expectedSourceStatuses: {
            [ledger.orders.bid.orderHash]: ORDER_SOURCE_STATUS.Cancelled,
        },
    });
    actual.orders[1].source_status = ORDER_SOURCE_STATUS.Active;
    assert.throws(
        () =>
            assertMarketConvergence({
                snapshot: actual,
                ledger,
                expectedSourceStatuses: {
                    [ledger.orders.bid.orderHash]:
                        ORDER_SOURCE_STATUS.Cancelled,
                },
            }),
        { property: SIMULATION_PROPERTY.BuyValidation },
    );
});

test("terminal source endpoints need no retained full proof and preserve independent protocol state", () => {
    for (const source of [
        ORDER_SOURCE_STATUS.Cancelled,
        ORDER_SOURCE_STATUS.Filled,
        ORDER_SOURCE_STATUS.Expired,
    ]) {
        const actual = snapshot();
        const bid = actual.orders[1];
        bid.source_status = source;
        bid.fillability_status = ORDER_STATUS.Cancelled;
        bid.validated_at = 0;
        actual.validationProofs = actual.validationProofs.filter(
            (proof) => proof.order_id !== bid.id,
        );
        assertMarketConvergence({
            snapshot: actual,
            ledger,
            expectedSourceStatuses: { [bid.id]: source },
        });
        assert.equal(bid.fillability_status, ORDER_STATUS.Cancelled);
        assert.equal(bid.validated_at, 0);
    }
});

test("the final ownership oracle rejects an extra orphan buyer balance", () => {
    const actual = snapshot({ head: 107 });
    actual.owners.push({
        token_id: "1",
        owner: ledger.addresses.buyer,
        amount: "1",
        last_block_number: 104,
    });
    assert.throws(
        () =>
            assertCanonicalAcquisition({
                snapshot: actual,
                ledger,
                branch: "B",
                head: 107,
            }),
        { property: SIMULATION_PROPERTY.CanonicalOwnership },
    );
});

test("the final ownership oracle protects the untouched token and exact ERC721 quantity", () => {
    for (const mutation of [
        (row) => {
            row.owner = ledger.addresses.buyer;
        },
        (row) => {
            row.amount = "2";
        },
        (row) => {
            row.amount = "0";
        },
    ]) {
        const actual = snapshot({ head: 107 });
        mutation(actual.owners[1]);
        assert.throws(
            () =>
                assertCanonicalAcquisition({
                    snapshot: actual,
                    ledger,
                    branch: "B",
                    head: 107,
                }),
            { property: SIMULATION_PROPERTY.CanonicalOwnership },
        );
    }
});

test("the final transfer oracle rejects an orphan retained after headers and ownership healed", () => {
    const actual = snapshot({ head: 107 });
    actual.transfers.push(
        transfer(
            "A",
            104,
            "1",
            ledger.addresses.seller,
            ledger.addresses.buyer,
        ),
    );
    assert.throws(
        () =>
            assertCanonicalAcquisition({
                snapshot: actual,
                ledger,
                branch: "B",
                head: 107,
            }),
        { property: SIMULATION_PROPERTY.CanonicalTransfers },
    );
});

test("the transfer oracle checks exact canonical identity, payload and multiplicity", () => {
    for (const mutate of [
        (facts) => {
            facts.pop();
        },
        (facts) => {
            facts.push({ ...facts[0] });
        },
        (facts) => {
            facts[0].from_address = ledger.addresses.buyer;
        },
        (facts) => {
            facts[0].to_address = ledger.addresses.buyer;
        },
        (facts) => {
            facts[0].amount = "2";
        },
        (facts) => {
            facts[0].tx_hash = ledger.blockAt("A", 104).transactions[0];
        },
        (facts) => {
            facts[0].log_index = 1;
        },
        (facts) => {
            facts[0].block_hash = ledger.blockAt("B", 102).hash;
        },
    ]) {
        const actual = snapshot();
        mutate(actual.transfers);
        assert.throws(
            () =>
                assertCanonicalAcquisition({
                    snapshot: actual,
                    ledger,
                    branch: "B",
                    head: 102,
                }),
            { property: SIMULATION_PROPERTY.CanonicalTransfers },
        );
    }
});

test("canonical acquisition derives both fork outcomes from the external ledger", () => {
    for (const branch of ["A", "B"])
        assertCanonicalAcquisition({
            snapshot: snapshot({ branch, head: 107 }),
            ledger,
            branch,
            head: 107,
        });
});

test("bootstrap snapshots require exact current owners without inventing pre-anchor transfer completeness", () => {
    const actual = snapshot({ head: 105 });
    actual.transfers = [];
    actual.owners.forEach((row) => {
        row.last_block_number = 102;
    });
    assertCanonicalAcquisition({
        snapshot: actual,
        ledger: { ...ledger, anchorBlock: 102 },
        branch: "B",
        head: 105,
    });
    actual.owners.pop();
    assert.throws(
        () =>
            assertCanonicalAcquisition({
                snapshot: actual,
                ledger: { ...ledger, anchorBlock: 102 },
                branch: "B",
                head: 105,
            }),
        { property: SIMULATION_PROPERTY.CanonicalOwnership },
    );
});
