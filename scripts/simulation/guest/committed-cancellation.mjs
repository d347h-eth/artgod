import assert from "node:assert/strict";
import { decodeRpcContractCalls } from "../world/wire.mjs";
import { RESPONSE_GATE_FUNCTION } from "../world/contract.mjs";

const lower = (value) =>
    typeof value === "string" ? value.toLowerCase() : undefined;

/** Witness the authored bidder counter-one read independently of the resulting
 * order row. Scalar read traces omit return bytes: a completed known-contract
 * call at this immutable A block has the ledger's counter. Deployless traces
 * additionally retain each executed leaf, whose success/value must agree.
 * The optional read bound fences external computation, not response delivery
 * or SQLite commit. A later completed transport handoff remains eligible. */
export function completedCounterValidationRead(trace, options) {
    const { ledger, afterSequence, blockNumber, readBeforeSequence } = options;
    assert.ok(Array.isArray(trace));
    assert.ok(Number.isSafeInteger(afterSequence) && afterSequence >= 0);
    assert.ok(Number.isSafeInteger(blockNumber) && blockNumber >= 0);
    const hasReadBound = Object.hasOwn(options, "readBeforeSequence");
    if (hasReadBound)
        assert.ok(
            Number.isSafeInteger(readBeforeSequence) &&
                readBeforeSequence >= afterSequence,
            "Counter read bound must be an explicit safe sequence at or after its window start",
        );
    const block = ledger.blockAt("A", blockNumber);
    const expectedCounter =
        ledger
            .stateAt("A", blockNumber)
            .counters.get(lower(ledger.addresses.bidder)) ?? 0n;
    // The fixture's explicit counter increment, rather than a zero/current
    // counter read, must support this cancellation exposure. It does not prove
    // when, or whether, the application consumed or committed that response.
    if (expectedCounter !== 1n) return undefined;
    const matchesCounter = (call) =>
        call?.functionName === RESPONSE_GATE_FUNCTION.Counter &&
        lower(call.target) === lower(ledger.addresses.seaport) &&
        call.args?.length === 1 &&
        lower(call.args[0]) === lower(ledger.addresses.bidder);
    for (const request of trace) {
        if (
            request.type !== "request" ||
            request.method !== "eth_call" ||
            !Number.isSafeInteger(request.sequence) ||
            request.sequence <= afterSequence ||
            !Number.isSafeInteger(request.requestIndex) ||
            request.requestIndex < 1 ||
            typeof request.provider !== "string" ||
            !request.provider
        )
            continue;
        let calls;
        try {
            calls = decodeRpcContractCalls(request);
        } catch {
            continue;
        }
        const counterIndices = calls.flatMap((call, index) =>
            matchesCounter(call) ? [index] : [],
        );
        if (!counterIndices.length) continue;
        const related = trace.filter(
            (entry) => entry.requestIndex === request.requestIndex,
        );
        const reads = related.filter((entry) => entry.type === "read");
        const completions = related.filter(
            (entry) => entry.type === "response",
        );
        if (
            related.filter((entry) => entry.type === "request").length !== 1 ||
            reads.length !== 1 ||
            completions.length !== 1 ||
            related.some((entry) => entry.type === "error")
        )
            continue;
        const [read] = reads;
        const [completion] = completions;
        if (
            !Number.isSafeInteger(read.sequence) ||
            !Number.isSafeInteger(completion.sequence) ||
            !(
                request.sequence < read.sequence &&
                read.sequence < completion.sequence
            ) ||
            (hasReadBound && read.sequence > readBeforeSequence) ||
            read.method !== "eth_call" ||
            completion.method !== "eth_call" ||
            read.provider !== request.provider ||
            completion.provider !== request.provider ||
            read.view?.branch !== "A" ||
            read.blockNumber !== blockNumber ||
            read.blockHash !== block.hash
        )
            continue;
        const aggregate = !request.params[0].to;
        if (
            aggregate &&
            (!Array.isArray(read.aggregateCalls) ||
                read.aggregateCalls.length !== calls.length ||
                !counterIndices.some((index) => {
                    const leaf = read.aggregateCalls[index];
                    return (
                        matchesCounter(leaf) &&
                        leaf.success === true &&
                        leaf.result === expectedCounter.toString()
                    );
                }))
        )
            continue;
        return {
            request,
            read,
            completion,
            expectedCounter: expectedCounter.toString(),
            block: {
                branch: "A",
                number: block.number,
                hash: block.hash,
                timestamp: block.timestamp,
            },
        };
    }
    return undefined;
}
