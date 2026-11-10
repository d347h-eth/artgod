import assert from "node:assert/strict";
import { ORDER_SEAPORT_DATA_SOURCE_KIND } from "../../../indexer/src/domain/orders.ts";
import { RPC_RESPONSE_EVENT } from "../world/contract.mjs";

export const PROVIDER_DISAGREEMENT_PHASE = Object.freeze({
    Acquisition: "provider-disagreement-acquisition",
    Armed: "provider-disagreement",
    Healed: "provider-disagreement-healed",
});
export const PROVIDER_DISAGREEMENT_PROPERTY = Object.freeze({
    Prelude: "coherent-chain-and-metadata-before-provider-fault",
    Admission: "new-source-revision-admits-validation",
    Read: "new-validation-reaches-disagreeing-provider",
    Proof: "fresh-validation-proof-after-provider-healing",
});
export const PROVIDER_READ_OUTCOME = Object.freeze({
    NumericAccepted: "numeric-fork-read-returned",
    HashRefused: "hash-pinned-fork-read-refused",
});

/** Refused hash reads can skip a response script's after-effect; heal explicitly. */
export function healDisagreementProviders(world, providers, head) {
    assert.ok(
        providers.length > 0 && new Set(providers).size === providers.length,
    );
    for (const provider of providers)
        world.setProviderView(provider, { branch: "A", head });
    world.setPhase(PROVIDER_DISAGREEMENT_PHASE.Healed);
}

/** A prior metadata read or transport handoff cannot earn finished fault coverage. */
export function completedDisagreementRead(
    trace,
    { afterSequence, minimumBlock },
) {
    for (const request of trace) {
        if (
            request.sequence <= afterSequence ||
            request.type !== "request" ||
            request.phase !== PROVIDER_DISAGREEMENT_PHASE.Armed ||
            request.method !== "eth_call" ||
            request.functionName !== "ownerOf"
        )
            continue;
        const completion = trace.find(
            (entry) =>
                entry.requestIndex === request.requestIndex &&
                entry.sequence > request.sequence &&
                ["response", "error"].includes(entry.type),
        );
        if (!completion) continue;
        const delivery = trace.find(
            (entry) =>
                entry.type === RPC_RESPONSE_EVENT.Finished &&
                entry.requestIndex === request.requestIndex &&
                entry.provider === request.provider &&
                entry.method === request.method &&
                entry.sequence > completion.sequence &&
                entry.outcome === completion.type &&
                (completion.type !== "error" ||
                    (entry.code === completion.code &&
                        entry.message === completion.message)),
        );
        if (!delivery) continue;
        const read = trace.find(
            (entry) =>
                entry.requestIndex === request.requestIndex &&
                entry.type === "read",
        );
        if (
            completion.type === "response" &&
            typeof request.params?.[1] === "string" &&
            /^0x[0-9a-f]+$/i.test(request.params[1]) &&
            read?.view.branch === "B" &&
            read.sequence > request.sequence &&
            read.sequence < completion.sequence &&
            read.blockNumber >= minimumBlock
        )
            return {
                outcome: PROVIDER_READ_OUTCOME.NumericAccepted,
                request,
                read,
                completion,
                delivery,
            };
        // The external provider must refuse a noncanonical EIP-1898 selector.
        // This is a deliberate assertion of its modeled JSON-RPC wire boundary.
        const selector = request.params?.[1];
        const header = trace.findLast(
            (entry) =>
                entry.type === "read" &&
                entry.method === "eth_getBlockByNumber" &&
                entry.sequence > afterSequence &&
                entry.sequence < request.sequence &&
                entry.blockHash === selector?.blockHash &&
                entry.blockNumber >= minimumBlock &&
                trace.some(
                    (finished) =>
                        finished.type === "response" &&
                        finished.requestIndex === entry.requestIndex &&
                        finished.sequence > entry.sequence &&
                        finished.sequence < request.sequence,
                ),
        );
        if (
            completion.type === "error" &&
            /^0x[0-9a-f]{64}$/i.test(selector?.blockHash ?? "") &&
            selector.requireCanonical === true &&
            header &&
            completion.code === -32001 &&
            /block hash is not canonical/.test(completion.message)
        )
            return {
                outcome: PROVIDER_READ_OUTCOME.HashRefused,
                request,
                completion,
                delivery,
                header,
            };
    }
    return undefined;
}

/** Canonical source mutation and its new generation must own this full proof. */
export function assertFreshValidatorProof({
    before,
    current,
    orderId,
    sourceEventAt,
    minimumBlock,
}) {
    assert.ok(
        minimumBlock === null ||
            (Number.isSafeInteger(minimumBlock) && minimumBlock >= 0),
        "Fresh validation requires an explicit valid block floor or null",
    );
    const oldOrder = before.orders.find((row) => row.id === orderId);
    const oldProof = before.validationProofs.find(
        (row) => row.order_id === orderId,
    );
    const order = current.orders.find((row) => row.id === orderId);
    const proof = current.validationProofs.find(
        (row) => row.order_id === orderId,
    );
    assert.ok(
        oldOrder && oldProof && order && proof,
        "Both persisted validator checkpoints are required",
    );
    assert.ok(
        order.state_revision > oldOrder.state_revision,
        "The actual source observation must create a new canonical revision",
    );
    assert.equal(
        order.seaport_data_source_kind,
        ORDER_SEAPORT_DATA_SOURCE_KIND.Stream,
    );
    assert.ok(
        proof.generation > oldProof.generation,
        "A new durable demand generation must be observed",
    );
    assert.equal(proof.pending, 0, "The new validation generation must settle");
    assert.equal(
        proof.proof_revision,
        order.state_revision,
        "Full proof must validate the new source revision",
    );
    assert.equal(
        proof.proof_chain_revision,
        current.revision,
        "Full proof must use the current chain revision",
    );
    assert.ok(
        Number.isSafeInteger(proof.proof_block) && proof.proof_block >= 0,
        "Full proof requires an explicit valid observed block",
    );
    assert.ok(
        minimumBlock === null || proof.proof_block >= minimumBlock,
        "Full proof must cover the retained validation block floor",
    );
    assert.ok(
        proof.proof_at >= sourceEventAt * 1000 &&
            proof.proof_at > oldProof.proof_at,
        "A prior proof cannot qualify the fresh source admission",
    );
    assert.ok(order.validated_at > 0);
    return { order, proof };
}
