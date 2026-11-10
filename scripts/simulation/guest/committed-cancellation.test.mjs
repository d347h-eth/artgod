import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, custom, encodeFunctionData } from "viem";
import { createSimulationWorld } from "../world/world.mjs";
import { CONTRACT_ABI, wireQuantity } from "../world/wire.mjs";
import { RESPONSE_GATE_FUNCTION } from "../world/contract.mjs";
import { completedCounterValidationRead } from "./committed-cancellation.mjs";

// Real external ABI/trace inputs; no production worker, storage or queue is
// replaced or executed by these guard tests.
async function fixture({
    aggregate = false,
    functionName = RESPONSE_GATE_FUNCTION.Counter,
} = {}) {
    const world = createSimulationWorld({
        epochSeconds: 1_800_000_000,
        providers: { default: { branch: "A", head: 105 } },
    });
    const ledger = world.ledger;
    const call = {
        address: ledger.addresses.seaport,
        abi: CONTRACT_ABI,
        functionName,
        args: [
            functionName === RESPONSE_GATE_FUNCTION.Counter
                ? ledger.addresses.bidder
                : ledger.orders.bid.orderHash,
        ],
    };
    if (aggregate)
        await createPublicClient({
            transport: custom({
                request: ({ method, params }) =>
                    world.handleRpc("default", {
                        jsonrpc: "2.0",
                        id: 1,
                        method,
                        params,
                    }),
            }),
        }).multicall({
            contracts: [
                {
                    address: ledger.addresses.seaport,
                    abi: CONTRACT_ABI,
                    functionName: RESPONSE_GATE_FUNCTION.OrderStatus,
                    args: [ledger.orders.bid.orderHash],
                },
                call,
            ],
            blockNumber: 105n,
            deployless: true,
            batchSize: 0,
            allowFailure: true,
        });
    else
        await world.handleRpc("default", {
            jsonrpc: "2.0",
            id: 1,
            method: "eth_call",
            params: [
                { to: call.address, data: encodeFunctionData(call) },
                wireQuantity(105),
            ],
        });
    return {
        world,
        ledger,
        trace: structuredClone(world.trace),
        input: { ledger, afterSequence: 0, blockNumber: 105 },
    };
}

test("a completed direct bidder counter read witnesses immutable A105 counter one", async () => {
    const f = await fixture();
    const witness = completedCounterValidationRead(f.trace, f.input);
    assert.equal(witness.expectedCounter, "1");
    assert.deepEqual(witness.block, {
        branch: "A",
        number: 105,
        hash: f.ledger.blockAt("A", 105).hash,
        timestamp: f.ledger.blockAt("A", 105).timestamp,
    });
    assert.equal(witness.request, f.trace[0]);
    assert.equal(witness.read, f.trace[1]);
    assert.equal(witness.completion, f.trace[2]);
});

test("a real deployless aggregate must contain its successful matching counter-one leaf", async () => {
    const f = await fixture({ aggregate: true });
    const witness = completedCounterValidationRead(f.trace, f.input);
    assert.equal(witness.expectedCounter, "1");
    assert.equal(witness.read.aggregateCalls[1].result, "1");
    assert.equal(witness.read.aggregateCalls[1].success, true);
});

test("wrong maker or contract and non-counter calldata cannot witness cancellation", async () => {
    const f = await fixture();
    for (const transaction of [
        {
            to: f.ledger.addresses.seaport,
            data: encodeFunctionData({
                abi: CONTRACT_ABI,
                functionName: RESPONSE_GATE_FUNCTION.Counter,
                args: [f.ledger.addresses.seller],
            }),
        },
        { ...f.trace[0].params[0], to: f.ledger.addresses.nft },
        {
            to: f.ledger.addresses.seaport,
            data: encodeFunctionData({
                abi: CONTRACT_ABI,
                functionName: RESPONSE_GATE_FUNCTION.OrderStatus,
                args: [f.ledger.orders.bid.orderHash],
            }),
        },
    ]) {
        const trace = structuredClone(f.trace);
        trace[0].params[0] = transaction;
        assert.equal(completedCounterValidationRead(trace, f.input), undefined);
    }
});

test("wrong branch, block or block hash cannot qualify a completed read", async () => {
    const f = await fixture();
    for (const mutate of [
        (read) => {
            read.view.branch = "B";
            read.blockHash = f.ledger.blockAt("B", 105).hash;
        },
        (read) => {
            read.blockNumber = 104;
        },
        (read) => {
            read.blockHash = f.ledger.blockAt("B", 105).hash;
        },
        (read) => {
            read.provider = "other";
        },
    ]) {
        const trace = structuredClone(f.trace);
        mutate(trace[1]);
        assert.equal(completedCounterValidationRead(trace, f.input), undefined);
    }
});

test("the request must begin inside the declared window and complete after its read", async () => {
    const f = await fixture();
    assert.equal(
        completedCounterValidationRead(f.trace, {
            ...f.input,
            afterSequence: f.trace[0].sequence,
        }),
        undefined,
    );
    assert.equal(
        completedCounterValidationRead(f.trace.slice(0, 2), f.input),
        undefined,
    );
    for (const mutate of [
        (trace) => {
            trace[2].sequence = trace[1].sequence;
        },
        (trace) => {
            trace[1].sequence = trace[0].sequence;
        },
        (trace) => {
            trace[2].type = "error";
        },
        (trace) => {
            trace[2].requestIndex++;
        },
        (trace) => {
            trace.push({ ...trace[2], type: "error", sequence: 4 });
        },
    ]) {
        const trace = structuredClone(f.trace);
        mutate(trace);
        assert.equal(completedCounterValidationRead(trace, f.input), undefined);
    }
});

test("an outer aggregate response cannot hide a reverted or wrong-value counter leaf", async () => {
    const f = await fixture({ aggregate: true });
    for (const mutate of [
        (read) => {
            read.aggregateCalls[1].success = false;
        },
        (read) => {
            read.aggregateCalls[1].result = "0";
        },
        (read) => {
            read.aggregateCalls[1].args = [f.ledger.addresses.seller];
        },
        (read) => {
            read.aggregateCalls[1].target = f.ledger.addresses.nft;
        },
        (read) => {
            read.aggregateCalls.reverse();
        },
        (read) => {
            read.aggregateCalls = [read.aggregateCalls[0]];
        },
        (read) => {
            delete read.aggregateCalls;
        },
        (read) => {
            read.aggregateCalls[1] = null;
        },
    ]) {
        const trace = structuredClone(f.trace);
        mutate(trace[1]);
        assert.equal(completedCounterValidationRead(trace, f.input), undefined);
    }
});

test("a valid read at a zero-counter block cannot invent the authored increment", async () => {
    const f = await fixture();
    assert.equal(
        completedCounterValidationRead(f.trace, {
            ...f.input,
            blockNumber: 104,
        }),
        undefined,
    );
});

test("a pre-cut counter computation remains eligible when its transport handoff completes later", async () => {
    for (const aggregate of [false, true]) {
        const f = await fixture({ aggregate });
        const witness = completedCounterValidationRead(f.trace, {
            ...f.input,
            readBeforeSequence: f.trace[1].sequence,
        });
        assert.equal(witness.read.sequence, f.trace[1].sequence);
        assert.ok(witness.completion.sequence > f.trace[1].sequence);
    }
});

test("a counter computed after the cut cannot qualify even with a matching A105 response", async () => {
    const f = await fixture();
    assert.equal(
        completedCounterValidationRead(f.trace, {
            ...f.input,
            readBeforeSequence: f.trace[0].sequence,
        }),
        undefined,
    );
    // Omitting the optional bound preserves the all-observed-trace contract.
    assert.ok(completedCounterValidationRead(f.trace, f.input));
});

test("an explicitly supplied malformed or reversed read bound cannot silently become unbounded", async () => {
    const f = await fixture();
    for (const readBeforeSequence of [
        undefined,
        null,
        "2",
        -1,
        0.5,
        Number.NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
    ])
        assert.throws(
            () =>
                completedCounterValidationRead(f.trace, {
                    ...f.input,
                    readBeforeSequence,
                }),
            /explicit safe sequence/,
        );
    assert.throws(
        () =>
            completedCounterValidationRead(f.trace, {
                ...f.input,
                afterSequence: 2,
                readBeforeSequence: 1,
            }),
        /explicit safe sequence/,
    );
});

test("an earlier request whose read misses the cut cannot mask a later eligible completed request", async () => {
    const world = createSimulationWorld({
        epochSeconds: 1_800_000_000,
        providers: { default: { branch: "A", head: 105 } },
        scripts: [
            {
                when: {
                    method: "eth_call",
                    functionName: RESPONSE_GATE_FUNCTION.Counter,
                    occurrence: 1,
                },
                before: { barrier: "late-first-counter-read" },
            },
        ],
    });
    const call = (id) =>
        world.handleRpc("default", {
            jsonrpc: "2.0",
            id,
            method: "eth_call",
            params: [
                {
                    to: world.ledger.addresses.seaport,
                    data: encodeFunctionData({
                        abi: CONTRACT_ABI,
                        functionName: RESPONSE_GATE_FUNCTION.Counter,
                        args: [world.ledger.addresses.bidder],
                    }),
                },
                wireQuantity(105),
            ],
        });
    const first = call(1);
    await world.waitForBarrier("late-first-counter-read");
    await call(2);
    const readBeforeSequence = world.trace.at(-1).sequence;
    world.release("late-first-counter-read");
    await first;
    const input = { ledger: world.ledger, afterSequence: 0, blockNumber: 105 };
    assert.equal(
        completedCounterValidationRead(world.trace, input).request.requestIndex,
        1,
    );
    const witness = completedCounterValidationRead(world.trace, {
        ...input,
        readBeforeSequence,
    });
    assert.equal(witness.request.requestIndex, 2);
    assert.ok(witness.read.sequence <= readBeforeSequence);
});
