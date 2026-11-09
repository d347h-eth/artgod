import assert from "node:assert/strict";
import test from "node:test";
import { encodeFunctionData } from "viem";
import {
    ORDER_STATUS,
    ORDER_SOURCE_STATUS,
    ORDER_SIDE,
} from "../../../shared/market-data/orders.ts";
import {
    assertCanonicalAcquisition,
    assertMarketConvergence,
    SIMULATION_PROPERTY,
} from "./oracle.mjs";
import { createBaselineLedger } from "../world/ledger.mjs";
import { ZERO_ADDRESS, CONTRACT_ABI, wireQuantity } from "../world/wire.mjs";
import { RESPONSE_GATE_FUNCTION } from "../world/contract.mjs";
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
        side: order.side,
        block_number: null,
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

const retainedCancellationFixture = () => {
    const before = snapshot({ branch: "A", head: 105 });
    before.revision = 0;
    const order = before.orders.find(
        (row) => row.id === ledger.orders.bid.orderHash,
    );
    order.fillability_status = ORDER_STATUS.Cancelled;
    const proof = before.validationProofs.find(
        (row) => row.order_id === order.id,
    );
    proof.proof_chain_revision = before.revision;
    proof.proof_block = 105;
    const current = snapshot({ branch: "B", head: 107 });
    current.orders[1] = structuredClone(order);
    current.validationProofs[1] = structuredClone(proof);
    return { before, current, orderId: order.id };
};
const assertRetainedFixture = ({ before, current, orderId }) =>
    assertMarketConvergence({
        snapshot: current,
        ledger,
        retainedCancellationWitnesses: [{ orderId, before }],
    });

test("an actual committed unattributed cancellation earns a distinct retained terminal endpoint", () => {
    const fixture = retainedCancellationFixture();
    const { retainedCancellations } = assertRetainedFixture(fixture);
    assert.equal(retainedCancellations.length, 1);
    assert.equal(
        retainedCancellations[0].property,
        SIMULATION_PROPERTY.RetainedUnattributedCancellation,
    );
    assert.equal(retainedCancellations[0].before.proof.proof_block, 105);
    assert.equal(
        retainedCancellations[0].current.proof.proof_chain_revision,
        0,
    );
    assert.equal(retainedCancellations[0].current.order.side, ORDER_SIDE.Buy);
});

test("retained terminal metadata may advance and both checkpoint proofs may be cleared without claiming freshness", () => {
    const fixture = retainedCancellationFixture();
    fixture.before.validationProofs.splice(1, 1);
    fixture.current.orders[1].state_revision++;
    fixture.current.orders[1].validated_at = 0;
    fixture.current.validationProofs.splice(1, 1);
    const { retainedCancellations } = assertRetainedFixture(fixture);
    assert.equal(retainedCancellations[0].current.order.validated_at, 0);
    assert.equal(retainedCancellations[0].before.proof, null);
    assert.equal(retainedCancellations[0].current.proof, null);
});

test("cancelled final status without an actual before witness still fails executable convergence", () => {
    const fixture = retainedCancellationFixture();
    assert.throws(
        () => assertMarketConvergence({ snapshot: fixture.current, ledger }),
        {
            property: SIMULATION_PROPERTY.BuyValidation,
        },
    );
    for (const retainedCancellationWitnesses of [
        null,
        Array(1),
        [{}],
        [{ orderId: fixture.orderId }],
        [{ orderId: "unknown", before: fixture.before }],
        [{ orderId: ledger.orders.listing.orderHash, before: fixture.before }],
        [
            { orderId: fixture.orderId, before: fixture.before },
            { orderId: fixture.orderId, before: fixture.before },
        ],
    ])
        assert.throws(
            () =>
                assertMarketConvergence({
                    snapshot: fixture.current,
                    ledger,
                    retainedCancellationWitnesses,
                }),
            {
                property: SIMULATION_PROPERTY.RetainedUnattributedCancellation,
            },
        );
});

test("retention refuses wrong source, attributed state, missing target, revival and absent rollback", () => {
    for (const mutate of [
        (f) => {
            f.before.orders[1].fillability_status = ORDER_STATUS.Fillable;
        },
        (f) => {
            f.before.orders[1].source_status = ORDER_SOURCE_STATUS.Cancelled;
        },
        (f) => {
            f.before.orders[1].block_number = 105;
        },
        (f) => {
            delete f.before.orders[1].block_number;
        },
        (f) => {
            f.before.orders[1].validated_at = 0;
        },
        (f) => {
            f.before.orders[1].id = "other";
        },
        (f) => {
            f.before.orders[1].side = ORDER_SIDE.Sell;
        },
        (f) => {
            f.current.orders[1].fillability_status = ORDER_STATUS.Fillable;
        },
        (f) => {
            f.current.orders[1].source_status = ORDER_SOURCE_STATUS.Cancelled;
        },
        (f) => {
            f.current.orders[1].block_number = 105;
        },
        (f) => {
            delete f.current.orders[1].block_number;
        },
        (f) => {
            f.current.orders[1].id = "other";
        },
        (f) => {
            f.current.orders[1].side = ORDER_SIDE.Sell;
        },
        (f) => {
            f.current.orders.splice(1, 1);
        },
        (f) => {
            f.current.revision = f.before.revision;
        },
        (f) => {
            f.before.revision = -1;
        },
        (f) => {
            f.current.revision = undefined;
        },
    ]) {
        const fixture = retainedCancellationFixture();
        mutate(fixture);
        assert.throws(() => assertRetainedFixture(fixture), {
            property: SIMULATION_PROPERTY.RetainedUnattributedCancellation,
        });
    }
});

test("witnessed bid retention does not bypass other orders' full executable proof requirements", () => {
    for (const mutate of [
        (f) => {
            f.current.orders[0].fillability_status = ORDER_STATUS.Cancelled;
        },
        (f) => {
            f.current.validationProofs[0].proof_revision--;
        },
        (f) => {
            f.current.validationProofs[0].proof_at =
                f.current.validationProofs[0].required_at - 1;
        },
        (f) => {
            f.current.validationProofs[0].proof_block =
                f.current.validationProofs[0].minimum_block - 1;
        },
        (f) => {
            f.current.validationProofs.splice(0, 1);
        },
    ]) {
        const fixture = retainedCancellationFixture();
        mutate(fixture);
        assert.throws(() => assertRetainedFixture(fixture), {
            property: SIMULATION_PROPERTY.SellValidation,
        });
    }
});

const counterExposureFixture = () => {
    const initial = snapshot({ head: 103 });
    initial.revision = 0;
    for (const proof of initial.validationProofs)
        proof.proof_chain_revision = 0;
    const current = snapshot({ head: 107 });
    current.revision = 1;
    for (const proof of current.validationProofs)
        proof.proof_chain_revision = 1;
    current.orders[1].fillability_status = ORDER_STATUS.Cancelled;
    current.orders[1].state_revision++;
    current.orders[1].validated_at = 0;
    current.validationProofs.splice(1, 1);
    const context = {
        provider: "a",
        requestIndex: 7,
        method: "eth_call",
        functionName: RESPONSE_GATE_FUNCTION.Counter,
    };
    const counterRead = {
        request: {
            ...context,
            type: "request",
            sequence: 11,
            params: [
                {
                    to: ledger.addresses.seaport,
                    data: encodeFunctionData({
                        abi: CONTRACT_ABI,
                        functionName: RESPONSE_GATE_FUNCTION.Counter,
                        args: [ledger.addresses.bidder],
                    }),
                },
                wireQuantity(ledger.counterBlock),
            ],
        },
        read: {
            ...context,
            type: "read",
            sequence: 12,
            view: { branch: "A", head: ledger.counterBlock },
            blockNumber: ledger.counterBlock,
            blockHash: ledger.blockAt("A", ledger.counterBlock).hash,
        },
        completion: {
            ...context,
            type: "response",
            sequence: 30,
            view: { branch: "B", head: 107 },
        },
    };
    return {
        initial,
        current,
        orderId: ledger.orders.bid.orderHash,
        counterRead,
        afterSequence: 10,
        readBeforeSequence: 20,
    };
};
const assertCounterExposure = ({ current, ...exposure }) =>
    assertMarketConvergence({
        snapshot: current,
        ledger,
        counterCancellationExposures: [exposure],
    });

test("an actual pre-healing counter exposure permits cancellation without claiming retention, rejection or fresh proof", () => {
    const fixture = counterExposureFixture();
    const result = assertCounterExposure(fixture);
    assert.deepEqual(result.retainedCancellations, []);
    assert.equal(result.permittedCancellations.length, 1);
    const permitted = result.permittedCancellations[0];
    assert.equal(
        permitted.property,
        SIMULATION_PROPERTY.PermittedUnattributedCancellation,
    );
    assert.equal(permitted.current.proof, null);
    assert.equal(permitted.counterRead.expectedCounter, "1");
    assert.ok(
        permitted.counterRead.completion.sequence >
            permitted.readBeforeSequence,
    );
    assert.equal(permitted.retentionProven, false);
    assert.equal(permitted.staleRejectionProven, false);
    assert.equal(permitted.currentExecutableProofProven, false);
});

test("counter endpoint revalidates raw triplet instead of trusting claimed counter or block metadata", () => {
    const fixture = counterExposureFixture();
    fixture.counterRead.expectedCounter = "999";
    fixture.counterRead.block = { branch: "B", number: 0, hash: "forged" };
    const result = assertCounterExposure(fixture).permittedCancellations[0];
    assert.equal(result.counterRead.expectedCounter, "1");
    assert.equal(result.counterRead.block.number, ledger.counterBlock);
    assert.equal(
        result.counterRead.block.hash,
        ledger.blockAt("A", ledger.counterBlock).hash,
    );
});

test("permitted cancellation still requires known initial identity, real rollback and explicit terminal attribution", () => {
    for (const mutate of [
        (f) => {
            f.orderId = ledger.orders.listing.orderHash;
        },
        (f) => {
            f.orderId = "unknown";
        },
        (f) => {
            f.initial.orders.splice(1, 1);
        },
        (f) => {
            f.initial.orders[1].fillability_status = ORDER_STATUS.Cancelled;
        },
        (f) => {
            f.initial.orders[1].source_status = ORDER_SOURCE_STATUS.Cancelled;
        },
        (f) => {
            f.initial.orders[1].validated_at = 0;
        },
        (f) => {
            f.current.revision = f.initial.revision;
        },
        (f) => {
            f.current.orders[1].source_status = ORDER_SOURCE_STATUS.Cancelled;
        },
        (f) => {
            f.current.orders[1].fillability_status = ORDER_STATUS.Fillable;
        },
        (f) => {
            f.current.orders[1].block_number = ledger.counterBlock;
        },
        (f) => {
            delete f.current.orders[1].block_number;
        },
        (f) => {
            f.current.orders.splice(1, 1);
        },
    ]) {
        const fixture = counterExposureFixture();
        mutate(fixture);
        assert.throws(() => assertCounterExposure(fixture), {
            property: SIMULATION_PROPERTY.PermittedUnattributedCancellation,
        });
    }
});

test("missing, post-healing, wrong-fork, wrong-maker or different-height reads cannot permit terminal state", () => {
    for (const mutate of [
        (f) => {
            delete f.counterRead;
        },
        (f) => {
            delete f.counterRead.completion;
        },
        (f) => {
            delete f.readBeforeSequence;
        },
        (f) => {
            f.readBeforeSequence = null;
        },
        (f) => {
            f.counterRead.read.sequence = 21;
        },
        (f) => {
            f.counterRead.read.blockHash = ledger.blockAt(
                "B",
                ledger.counterBlock,
            ).hash;
        },
        (f) => {
            f.counterRead.read.view.branch = "B";
        },
        (f) => {
            f.counterRead.request.params[0].data = encodeFunctionData({
                abi: CONTRACT_ABI,
                functionName: RESPONSE_GATE_FUNCTION.Counter,
                args: [ledger.addresses.seller],
            });
        },
        (f) => {
            const height = ledger.counterBlock + 1;
            f.counterRead.request.params[1] = wireQuantity(height);
            f.counterRead.read.blockNumber = height;
            f.counterRead.read.blockHash = ledger.blockAt("A", height).hash;
        },
    ]) {
        const fixture = counterExposureFixture();
        mutate(fixture);
        assert.throws(() => assertCounterExposure(fixture), {
            property: SIMULATION_PROPERTY.PermittedUnattributedCancellation,
        });
    }
});

test("counter exposure input cannot omit its initial witness, duplicate a bid or override source cancellation", () => {
    const fixture = counterExposureFixture();
    const { current, ...exposure } = fixture;
    for (const counterCancellationExposures of [
        null,
        Array(1),
        [{}],
        [{ ...exposure, initial: undefined }],
        [exposure, exposure],
    ])
        assert.throws(
            () =>
                assertMarketConvergence({
                    snapshot: current,
                    ledger,
                    counterCancellationExposures,
                }),
            {
                property: SIMULATION_PROPERTY.PermittedUnattributedCancellation,
            },
        );
    assert.throws(
        () =>
            assertMarketConvergence({
                snapshot: current,
                ledger,
                counterCancellationExposures: [exposure],
                expectedSourceStatuses: {
                    [fixture.orderId]: ORDER_SOURCE_STATUS.Cancelled,
                },
            }),
        {
            property: SIMULATION_PROPERTY.PermittedUnattributedCancellation,
        },
    );
});

test("counter exposure cannot replace another order's full proof or also earn retained cancellation credit", () => {
    const fixture = counterExposureFixture();
    fixture.current.validationProofs[0].proof_at =
        fixture.current.validationProofs[0].required_at - 1;
    assert.throws(() => assertCounterExposure(fixture), {
        property: SIMULATION_PROPERTY.SellValidation,
    });
    const retained = retainedCancellationFixture();
    assert.throws(
        () =>
            assertMarketConvergence({
                snapshot: retained.current,
                ledger,
                retainedCancellationWitnesses: [
                    { orderId: retained.orderId, before: retained.before },
                ],
                counterCancellationExposures: [
                    { ...counterExposureFixture(), orderId: retained.orderId },
                ],
            }),
        { property: SIMULATION_PROPERTY.PermittedUnattributedCancellation },
    );
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
