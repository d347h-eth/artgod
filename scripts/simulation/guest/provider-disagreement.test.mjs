import assert from "node:assert/strict";
import test from "node:test";
import { ORDER_SEAPORT_DATA_SOURCE_KIND as SOURCE_KIND } from "../../../indexer/src/domain/orders.ts";
import { RPC_RESPONSE_EVENT } from "../world/contract.mjs";
import {
    completedDisagreementRead,
    healDisagreementProviders,
    assertFreshValidatorProof,
    PROVIDER_DISAGREEMENT_PHASE as PHASE,
    PROVIDER_READ_OUTCOME as OUTCOME,
} from "./provider-disagreement.mjs";

const observed = () => ({
    revision: 0,
    orders: [
        {
            id: "listing",
            state_revision: 1,
            validated_at: 12,
            seaport_data_source_kind: SOURCE_KIND.Rest,
        },
    ],
    validationProofs: [
        {
            order_id: "listing",
            generation: 1,
            pending: 0,
            proof_revision: 1,
            proof_chain_revision: 0,
            proof_block: 103,
            proof_at: 12_000,
        },
    ],
});
const fresh = () => {
    const current = observed();
    current.orders[0] = {
        ...current.orders[0],
        state_revision: 2,
        validated_at: 20,
        seaport_data_source_kind: SOURCE_KIND.Stream,
    };
    current.validationProofs[0] = {
        ...current.validationProofs[0],
        generation: 2,
        proof_revision: 2,
        proof_block: 104,
        proof_at: 20_100,
    };
    return current;
};
const proofInput = (current = fresh()) => ({
    before: observed(),
    current,
    orderId: "listing",
    sourceEventAt: 20,
    minimumBlock: 104,
});

test("a completed prior ownerOf request cannot stand in for the armed fresh validator read", () => {
    const trace = [
        {
            sequence: 1,
            type: "request",
            phase: PHASE.Acquisition,
            requestIndex: 1,
            method: "eth_call",
            functionName: "ownerOf",
        },
        {
            sequence: 2,
            type: "read",
            requestIndex: 1,
            view: { branch: "B" },
            blockNumber: 104,
        },
        { sequence: 3, type: "response", requestIndex: 1 },
    ];
    assert.equal(
        completedDisagreementRead(trace, {
            afterSequence: 3,
            minimumBlock: 104,
        }),
        undefined,
    );
    trace.push({
        sequence: 4,
        type: "request",
        phase: PHASE.Armed,
        requestIndex: 2,
        method: "eth_call",
        functionName: "ownerOf",
        params: [{}, "0x68"],
    });
    assert.equal(
        completedDisagreementRead(trace, {
            afterSequence: 3,
            minimumBlock: 104,
        }),
        undefined,
    );
    trace.push(
        {
            sequence: 5,
            type: "read",
            requestIndex: 2,
            view: { branch: "B" },
            blockNumber: 104,
        },
        { sequence: 6, type: "response", requestIndex: 2 },
        {
            sequence: 7,
            type: RPC_RESPONSE_EVENT.Finished,
            requestIndex: 2,
            method: "eth_call",
            outcome: "response",
        },
    );
    assert.equal(
        completedDisagreementRead(trace, {
            afterSequence: 3,
            minimumBlock: 104,
        }).outcome,
        OUTCOME.NumericAccepted,
    );
});
test("a genuine noncanonical hash refusal can be healed without demanding an incorrect numeric success", () => {
    const blockHash = `0x${"ab".repeat(32)}`;
    const trace = [
        {
            sequence: 10,
            type: "read",
            requestIndex: 2,
            method: "eth_getBlockByNumber",
            blockNumber: 104,
            blockHash,
        },
        { sequence: 11, type: "response", requestIndex: 2 },
        {
            sequence: 12,
            type: "request",
            phase: PHASE.Armed,
            requestIndex: 3,
            method: "eth_call",
            functionName: "ownerOf",
            params: [{}, { blockHash, requireCanonical: true }],
        },
        {
            sequence: 13,
            type: "error",
            requestIndex: 3,
            code: -32001,
            message: "Requested block hash is not canonical at provider",
        },
        {
            sequence: 14,
            type: RPC_RESPONSE_EVENT.Finished,
            requestIndex: 3,
            method: "eth_call",
            outcome: "error",
            code: -32001,
            message: "Requested block hash is not canonical at provider",
        },
    ];
    assert.equal(
        completedDisagreementRead(trace, {
            afterSequence: 9,
            minimumBlock: 104,
        }).outcome,
        OUTCOME.HashRefused,
    );
    const views = {
        default: { branch: "B", head: 104 },
        a: { branch: "A", head: 104 },
        b: { branch: "B", head: 104 },
    };
    let phase;
    healDisagreementProviders(
        {
            setProviderView: (id, view) => {
                views[id] = view;
            },
            setPhase: (value) => {
                phase = value;
            },
        },
        Object.keys(views),
        104,
    );
    assert.ok(
        Object.values(views).every(
            (view) => view.branch === "A" && view.head === 104,
        ),
    );
    assert.equal(phase, PHASE.Healed);
    trace[3].message = "Unknown fixture selector";
    assert.equal(
        completedDisagreementRead(trace, {
            afterSequence: 9,
            minimumBlock: 104,
        }),
        undefined,
    );
});
test("hash refusal needs the requested canonical snapshot and a matching finished transport response", () => {
    const hash = `0x${"ab".repeat(32)}`;
    const original = [
        {
            sequence: 1,
            type: "read",
            requestIndex: 1,
            method: "eth_getBlockByNumber",
            blockNumber: 104,
            blockHash: hash,
        },
        { sequence: 2, type: "response", requestIndex: 1 },
        {
            sequence: 3,
            type: "request",
            requestIndex: 2,
            provider: "a",
            phase: PHASE.Armed,
            method: "eth_call",
            functionName: "ownerOf",
            params: [{}, { blockHash: hash, requireCanonical: true }],
        },
        {
            sequence: 4,
            type: "error",
            requestIndex: 2,
            code: -32001,
            message: "Requested block hash is not canonical at provider",
        },
        {
            sequence: 5,
            type: RPC_RESPONSE_EVENT.Finished,
            requestIndex: 2,
            provider: "a",
            method: "eth_call",
            outcome: "error",
            code: -32001,
            message: "Requested block hash is not canonical at provider",
        },
    ];
    assert.equal(
        completedDisagreementRead(original, {
            afterSequence: 0,
            minimumBlock: 104,
        }).outcome,
        OUTCOME.HashRefused,
    );
    for (const mutate of [
        (t) => t.pop(),
        (t) => t.splice(0, 2),
        (t) => (t[0].blockHash = `0x${"cd".repeat(32)}`),
        (t) => (t[2].params[1].requireCanonical = false),
        (t) => (t[4].requestIndex = 9),
        (t) => (t[4].outcome = "response"),
        (t) => (t[4].provider = "b"),
        (t) => (t[4].sequence = 3),
    ]) {
        const trace = structuredClone(original);
        mutate(trace);
        assert.equal(
            completedDisagreementRead(trace, {
                afterSequence: 0,
                minimumBlock: 104,
            }),
            undefined,
        );
    }
});
test("fresh source audit or status alone cannot substitute for a new full validation proof", () => {
    assert.throws(
        () => assertFreshValidatorProof(proofInput(observed())),
        /new canonical revision/,
    );
    for (const mutation of [
        (value) => {
            value.validationProofs[0].generation = 1;
        },
        (value) => {
            value.validationProofs[0].proof_revision = 1;
        },
        (value) => {
            value.validationProofs[0].proof_block = 103;
        },
        (value) => {
            value.validationProofs[0].proof_at = 12_000;
        },
        (value) => {
            value.validationProofs[0].pending = 1;
        },
    ]) {
        const current = fresh();
        mutation(current);
        assert.throws(() => assertFreshValidatorProof(proofInput(current)));
    }
    assert.equal(
        assertFreshValidatorProof(proofInput()).proof.proof_block,
        104,
    );
});

// A rollback can advance the checkpoint before this new Stream admission.
// An older retained cache is legal in the baseline, but cannot cover the new work.
test("new post-rollback source proof must cover the current chain rather than its retained baseline", () => {
    const before = observed();
    before.revision = 1;
    const current = fresh();
    current.revision = 1;
    const input = { ...proofInput(current), before };
    assert.throws(
        () => assertFreshValidatorProof(input),
        /current chain revision/,
    );
    current.validationProofs[0].proof_chain_revision = 1;
    assert.equal(
        assertFreshValidatorProof(input).proof.proof_chain_revision,
        1,
    );
});

test("a fresh proof may settle a real null block floor without inventing the published head", () => {
    const current = fresh();
    current.validationProofs[0].proof_block = 103;
    assert.equal(
        assertFreshValidatorProof({
            ...proofInput(current),
            minimumBlock: null,
        }).proof.proof_block,
        103,
    );
});

test("fresh validation rejects missing or malformed block floors and observed blocks", () => {
    for (const minimumBlock of [undefined, -1, 1.5, NaN, Infinity, "104"]) {
        assert.throws(
            () =>
                assertFreshValidatorProof({
                    ...proofInput(),
                    minimumBlock,
                }),
            /explicit valid block floor or null/,
        );
    }
    for (const proofBlock of [undefined, null, -1, 1.5, NaN, Infinity, "103"]) {
        const current = fresh();
        current.validationProofs[0].proof_block = proofBlock;
        assert.throws(
            () =>
                assertFreshValidatorProof({
                    ...proofInput(current),
                    minimumBlock: null,
                }),
            /explicit valid observed block/,
        );
    }
});
