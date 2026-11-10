import assert from "node:assert/strict";
import { decodeEventLog, encodeEventTopics } from "viem";
import { COLLECTION_STANDARD } from "../../../shared/types/browse.ts";
import { TRANSFER_ABI } from "../world/wire.mjs";
import { assertSimulationProperty as property } from "./oracle-assertions.mjs";
import { assertCanonicalFillFacts } from "./fill-oracle.mjs";
import { completedCounterValidationRead } from "./committed-cancellation.mjs";
import {
    ORDER_STATUS,
    ORDER_SOURCE_STATUS,
    ORDER_SIDE,
} from "../../../shared/market-data/orders.ts";

export const SIMULATION_PROPERTY = Object.freeze({
    CollectionCoverage: "canonical-collection-coverage",
    CanonicalHeaders: "canonical-stored-headers",
    CanonicalOwnership: "canonical-erc721-ownership",
    CanonicalTransfers: "canonical-transfer-facts",
    SellValidation: "current-sell-validation",
    BuyValidation: "current-buy-validation",
    RetainedUnattributedCancellation: "retained-unattributed-cancellation",
    PermittedUnattributedCancellation: "permitted-unattributed-cancellation",
});

const TRANSFER_TOPIC = encodeEventTopics({
    abi: TRANSFER_ABI,
    eventName: "Transfer",
})[0];

const ownerOrder = (left, right) =>
    left.token_id.localeCompare(right.token_id) ||
    left.owner.localeCompare(right.owner);
const transferOrder = (left, right) =>
    left.block_number - right.block_number ||
    left.log_index - right.log_index ||
    left.token_id.localeCompare(right.token_id) ||
    left.tx_hash.localeCompare(right.tx_hash);

// Decode independent external wire facts, without invoking the production event
// decoder, ownership reducer, rollback implementation or persistence adapter.
function canonicalTransferFacts(ledger, branch, head) {
    const facts = [];
    for (let number = ledger.anchorBlock + 1; number <= head; number++) {
        const block = ledger.blockAt(branch, number);
        for (const log of block.logs) {
            if (
                log.address.toLowerCase() !==
                    ledger.addresses.nft.toLowerCase() ||
                log.topics[0] !== TRANSFER_TOPIC
            )
                continue;
            const { args } = decodeEventLog({
                abi: TRANSFER_ABI,
                data: log.data,
                topics: log.topics,
                strict: true,
            });
            facts.push({
                chain_id: ledger.chainId,
                contract_address: log.address.toLowerCase(),
                from_address: args.from.toLowerCase(),
                to_address: args.to.toLowerCase(),
                token_id: args.tokenId.toString(),
                amount: "1",
                block_number: block.number,
                block_hash: block.hash,
                block_timestamp: block.timestamp,
                tx_hash: log.transactionHash,
                log_index: Number(BigInt(log.logIndex)),
                kind: COLLECTION_STANDARD.Erc721,
            });
        }
    }
    return facts.sort(transferOrder);
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
    property(SIMULATION_PROPERTY.CanonicalOwnership, () => {
        const expected = [...ledger.stateAt(branch, head).owners].map(
            ([tokenId, owner]) => ({
                token_id: tokenId,
                owner: owner.toLowerCase(),
                amount: "1",
            }),
        );
        assert.deepEqual(
            snapshot.owners
                .map(({ token_id, owner, amount }) => ({
                    token_id,
                    owner,
                    amount,
                }))
                .sort(ownerOrder),
            expected.sort(ownerOrder),
            "Every simulated ERC721 must have exactly its canonical owner and one unit, without collateral or orphan balances",
        );
    });
    property(SIMULATION_PROPERTY.CanonicalTransfers, () => {
        const expected = canonicalTransferFacts(ledger, branch, head);
        // Bootstrap ownership snapshots do not guarantee stored pre-anchor
        // transfer history. Require exact facts for the range acquired here.
        assert.deepEqual(
            snapshot.transfers
                .filter((row) => row.block_number > ledger.anchorBlock)
                .map((row) =>
                    Object.fromEntries(
                        [
                            "chain_id",
                            "contract_address",
                            "from_address",
                            "to_address",
                            "token_id",
                            "amount",
                            "block_number",
                            "block_hash",
                            "block_timestamp",
                            "tx_hash",
                            "log_index",
                            "kind",
                        ].map((key) => [key, row[key]]),
                    ),
                )
                .sort(transferOrder),
            expected,
            "Stored post-anchor transfer facts must equal the canonical external logs exactly, with no missing, duplicate or orphan facts",
        );
    });
    assertCanonicalFillFacts({ snapshot, ledger, branch, head });
}

function assertObservedRevision(snapshot, name) {
    assert.ok(
        Number.isSafeInteger(snapshot?.revision) && snapshot.revision >= 0,
        `Cancellation endpoint requires a valid ${name} chain revision`,
    );
}

function observedBid(snapshot, orderId, name, status) {
    const order = snapshot.orders?.find((row) => row.id === orderId);
    assert.ok(order, `Cancellation endpoint requires the ${name} order`);
    assert.equal(order.side, ORDER_SIDE.Buy);
    assert.equal(order.source_status, ORDER_SOURCE_STATUS.Active);
    assert.equal(order.fillability_status, status);
    assert.equal(
        order.block_number,
        null,
        `Cancellation endpoint requires explicit unattributed ${name} evidence`,
    );
    return order;
}

function bidDiagnostics(snapshot, order) {
    return {
        revision: snapshot.revision,
        order,
        proof:
            snapshot.validationProofs?.find(
                (row) => row.order_id === order.id,
            ) ?? null,
    };
}

/** The caller admits this before snapshot only after witnessing the completed
 * A105 bidder-counter read and actual status commit before branch switch.
 * Terminal metadata/proof cleanup does not revoke that business-state witness. */
function retainedCancellation({ before, snapshot, orderId }) {
    assertObservedRevision(before, "before");
    assertObservedRevision(snapshot, "current");
    assert.ok(
        snapshot.revision > before.revision,
        "Retained cancellation must be observed after committed rollback",
    );
    const previous = observedBid(
        before,
        orderId,
        "before",
        ORDER_STATUS.Cancelled,
    );
    const current = observedBid(
        snapshot,
        orderId,
        "current",
        ORDER_STATUS.Cancelled,
    );
    assert.ok(
        Number.isSafeInteger(previous.validated_at) &&
            previous.validated_at > 0,
        "The pre-rollback cancellation must have actually been validated",
    );
    return {
        property: SIMULATION_PROPERTY.RetainedUnattributedCancellation,
        orderId,
        before: bidDiagnostics(before, previous),
        current: bidDiagnostics(snapshot, current),
    };
}

/** An actual counter-one read can explain the documented conservative terminal
 * endpoint without establishing when the application received or committed it.
 * Provider computation precedes healing; transport handoff may occur later. */
function permittedCancellation({
    initial,
    snapshot,
    ledger,
    orderId,
    counterRead,
    afterSequence,
    readBeforeSequence,
}) {
    assertObservedRevision(initial, "initial");
    assertObservedRevision(snapshot, "current");
    assert.ok(
        snapshot.revision > initial.revision,
        "The case must actually commit rollback after its initial state",
    );
    const previous = observedBid(
        initial,
        orderId,
        "initial",
        ORDER_STATUS.Fillable,
    );
    const current = observedBid(
        snapshot,
        orderId,
        "current",
        ORDER_STATUS.Cancelled,
    );
    assert.ok(
        Number.isSafeInteger(previous.validated_at) &&
            previous.validated_at > 0,
        "The initial bid must have an actual full validation checkpoint",
    );
    assert.ok(
        counterRead &&
            [
                counterRead.request,
                counterRead.read,
                counterRead.completion,
            ].every((entry) => entry && typeof entry === "object"),
        "An actual counter request/read/handoff triplet is required",
    );
    // Deliberately pass an explicit bound: an omitted/undefined healing cut must
    // not fall back to the matcher's otherwise valid all-observed behavior.
    const exposure = completedCounterValidationRead(
        [counterRead.request, counterRead.read, counterRead.completion],
        {
            ledger,
            afterSequence,
            blockNumber: ledger.counterBlock,
            readBeforeSequence,
        },
    );
    assert.ok(
        exposure,
        "The authored counter-one computation must precede provider healing",
    );
    return {
        property: SIMULATION_PROPERTY.PermittedUnattributedCancellation,
        orderId,
        initial: bidDiagnostics(initial, previous),
        current: bidDiagnostics(snapshot, current),
        counterRead: exposure,
        afterSequence,
        readBeforeSequence,
        retentionProven: false,
        staleRejectionProven: false,
        currentExecutableProofProven: false,
    };
}

/** Assert the fixture's declared market endpoints and executable proof coverage.
 * Optimistic intermediate visibility has its own production contract.
 * Non-active source evidence remains independent of protocol fillability.
 * Stored coverage may predate a rollback without having been reused. A
 * fixture-witnessed new request is checked separately by its freshness owner.
 * A retained cancellation requires its actual committed pre-rollback witness;
 * it earns a separate terminal endpoint, not executable-order proof coverage.
 * Ordinary forks may separately admit an actual counter-one exposure: that
 * permits conservative cancellation without claiming its unobserved commit cut.
 */
export function assertMarketConvergence({
    snapshot,
    ledger,
    expectedSourceStatuses = {},
    expectedListingFillability = ORDER_STATUS.Fillable,
    retainedCancellationWitnesses = [],
    counterCancellationExposures = [],
}) {
    property(SIMULATION_PROPERTY.SellValidation, () => {
        assert.ok(
            [ORDER_STATUS.Fillable, ORDER_STATUS.NoBalance].includes(
                expectedListingFillability,
            ),
            "The listing expectation supports only executable or recoverable ownership-loss fixtures",
        );
        if (expectedListingFillability === ORDER_STATUS.NoBalance)
            assert.equal(
                expectedSourceStatuses[ledger.orders.listing.orderHash] ??
                    ORDER_SOURCE_STATUS.Active,
                ORDER_SOURCE_STATUS.Active,
                "A recoverable listing expectation requires current active source evidence",
            );
    });
    const retainedCancellations = [];
    const permittedCancellations = [];
    property(SIMULATION_PROPERTY.RetainedUnattributedCancellation, () => {
        assert.ok(
            Array.isArray(retainedCancellationWitnesses) &&
                retainedCancellationWitnesses.length <= 1 &&
                Array.from(retainedCancellationWitnesses).every(
                    (witness) =>
                        witness &&
                        witness.orderId === ledger.orders.bid.orderHash &&
                        witness.before &&
                        (expectedSourceStatuses[witness.orderId] ??
                            ORDER_SOURCE_STATUS.Active) ===
                            ORDER_SOURCE_STATUS.Active,
                ),
            "Only the fixture bid's actual committed cancellation witness is supported",
        );
        for (const witness of retainedCancellationWitnesses)
            retainedCancellations.push(
                retainedCancellation({ ...witness, snapshot }),
            );
    });
    property(SIMULATION_PROPERTY.PermittedUnattributedCancellation, () => {
        assert.ok(
            Array.isArray(counterCancellationExposures) &&
                counterCancellationExposures.length <= 1 &&
                Array.from(counterCancellationExposures).every(
                    (exposure) =>
                        exposure &&
                        exposure.orderId === ledger.orders.bid.orderHash &&
                        exposure.initial &&
                        !retainedCancellations.some(
                            (entry) => entry.orderId === exposure.orderId,
                        ) &&
                        (expectedSourceStatuses[exposure.orderId] ??
                            ORDER_SOURCE_STATUS.Active) ===
                            ORDER_SOURCE_STATUS.Active,
                ),
            "Only a distinct exposure for the known active fixture bid is supported",
        );
        for (const exposure of counterCancellationExposures)
            permittedCancellations.push(
                permittedCancellation({ ...exposure, snapshot, ledger }),
            );
    });
    for (const [name, order] of Object.entries(ledger.orders)) {
        if (
            [...retainedCancellations, ...permittedCancellations].some(
                (entry) => entry.orderId === order.orderHash,
            )
        )
            continue;
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
                    name === "listing"
                        ? expectedListingFillability
                        : ORDER_STATUS.Fillable,
                    `Current ${name} must match the independently declared protocol state`,
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
                // These are deliberately read-only SQLite boundary fields.
                // Missing requirements are unknown evidence, not zero/null
                // defaults. The owning contract combines source identity,
                // chain identity and the retained observation/trigger floors.
                // Compare requirements independently of the production demand
                // predicate, so a regression in that predicate cannot bless its
                // own persisted result. Zero is a real canonical-event time;
                // null alone means that no event-height floor was requested.
                assert.ok(
                    Number.isSafeInteger(proof.required_at) &&
                        proof.required_at >= 0,
                    `Current ${name} requires an explicit source-time floor`,
                );
                assert.ok(
                    proof.minimum_block === null ||
                        (Number.isSafeInteger(proof.minimum_block) &&
                            proof.minimum_block >= 0),
                    `Current ${name} requires an explicit null or valid event-height floor`,
                );
                for (const [field, value] of [
                    ["canonical order revision", actual.state_revision],
                    ["canonical chain revision", snapshot.revision],
                    ["proof revision", proof.proof_revision],
                    ["proof chain revision", proof.proof_chain_revision],
                    ["proof observation time", proof.proof_at],
                    ["proof block", proof.proof_block],
                ])
                    assert.ok(
                        Number.isSafeInteger(value) && value >= 0,
                        `Current ${name} requires an explicit valid ${field}`,
                    );
                assert.equal(
                    proof.proof_revision,
                    actual.state_revision,
                    `Current ${name} proof must cover its canonical order revision`,
                );
                assert.ok(
                    proof.proof_chain_revision <= snapshot.revision,
                    `Current ${name} cannot retain proof from a future chain revision`,
                );
                assert.ok(
                    proof.proof_at >= proof.required_at,
                    `Current ${name} proof must cover its retained source-time requirement`,
                );
                assert.ok(
                    proof.minimum_block === null ||
                        proof.proof_block >= proof.minimum_block,
                    `Current ${name} proof must cover its retained event-height requirement`,
                );
            },
        );
    }
    return { retainedCancellations, permittedCancellations };
}
