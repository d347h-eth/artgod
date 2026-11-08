import assert from "node:assert/strict";
import { test } from "node:test";
import {
    createPublicClient,
    custom,
    decodeEventLog,
    decodeFunctionResult,
    encodeFunctionData,
    encodeEventTopics,
} from "viem";
import { createSimulationWorld } from "./world.mjs";
import { startWorldServer } from "./server.mjs";
import {
    METADATA_TRANSPORT,
    RESPONSE_GATE_FUNCTION as GATE_FUNCTION,
    RESPONSE_GATE_EVENT as GATE_EVENT,
} from "./contract.mjs";
import {
    CONTRACT_ABI,
    FULFILLED_ABI,
    TRANSFER_ABI,
    wireQuantity,
} from "./wire.mjs";

const epochSeconds = 1_800_000_000;
const request = (method, params = []) => ({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
});
const rpc = (world, provider, method, params) =>
    world.handleRpc(provider, request(method, params));
const call = (world, provider, address, functionName, args, block = "0x68") =>
    rpc(world, provider, "eth_call", [
        {
            to: address,
            data: encodeFunctionData({ abi: CONTRACT_ABI, functionName, args }),
        },
        block,
    ]).then((data) =>
        decodeFunctionResult({ abi: CONTRACT_ABI, functionName, data }),
    );

test("independent providers expose authentic fork history, receipt and ownership", async () => {
    const world = createSimulationWorld({ epochSeconds });
    world.advanceHead(107);
    const a = world.ledger.addresses;
    const client = createPublicClient({
        transport: custom({
            request: ({ method, params }) => rpc(world, "a", method, params),
        }),
    });
    const block = await client.getBlock({ blockNumber: 104n });
    assert.equal(block.number, 104n);
    assert.equal(block.hash, world.ledger.blockAt("A", 104).hash);
    assert.equal(block.transactions.length, 1);
    const receipt = await client.getTransactionReceipt({
        hash: block.transactions[0],
    });
    assert.equal(receipt.status, "success");
    assert.equal(receipt.blockHash, block.hash);
    assert.equal(receipt.logs.length, 2);
    const fill = decodeEventLog({ abi: FULFILLED_ABI, ...receipt.logs[1] });
    assert.equal(fill.eventName, "OrderFulfilled");
    assert.equal(fill.args.orderHash, world.ledger.orders.listing.orderHash);
    assert.equal(fill.args.offer[0].identifier, 1n);
    assert.equal(fill.args.consideration[0].amount, 1_000_000_000_000_000_000n);
    assert.equal(
        (await call(world, "a", a.nft, "ownerOf", [1n])).toLowerCase(),
        a.buyer,
    );
    assert.equal(
        (await call(world, "b", a.nft, "ownerOf", [1n])).toLowerCase(),
        a.seller,
    );
    assert.equal(
        await rpc(world, "b", "eth_getTransactionReceipt", [
            block.transactions[0],
        ]),
        null,
    );
    const commonA = await rpc(world, "a", "eth_getBlockByNumber", [
        "0x67",
        false,
    ]);
    const commonB = await rpc(world, "b", "eth_getBlockByNumber", [
        "0x67",
        false,
    ]);
    assert.deepEqual(commonA, commonB);
});

test("actual viem deployless multicall decodes two order statuses from one coherent provider block", async () => {
    const world = createSimulationWorld({ epochSeconds });
    world.advanceHead(107);
    const contracts = Object.values(world.ledger.orders).map((order) => ({
        address: world.ledger.addresses.seaport,
        abi: CONTRACT_ABI,
        functionName: "getOrderStatus",
        args: [order.orderHash],
    }));
    const client = (provider) =>
        createPublicClient({
            transport: custom({
                request: ({ method, params }) =>
                    rpc(world, provider, method, params),
            }),
        });
    const batch = async (provider, number) =>
        client(provider).multicall({
            contracts,
            blockNumber: BigInt(number),
            deployless: true,
            batchSize: 0,
            allowFailure: true,
        });
    assert.deepEqual(await batch("a", 103), [
        { status: "success", result: [false, false, 0n, 1n] },
        { status: "success", result: [false, false, 0n, 1n] },
    ]);
    assert.deepEqual(await batch("a", 104), [
        { status: "success", result: [true, false, 1n, 1n] },
        { status: "success", result: [false, false, 0n, 1n] },
    ]);
    assert.deepEqual(await batch("b", 104), [
        { status: "success", result: [false, false, 0n, 1n] },
        { status: "success", result: [false, false, 0n, 1n] },
    ]);
    const requests = world.trace.filter((entry) => entry.type === "request");
    assert.equal(requests.length, 3);
    assert.ok(
        requests.every(
            (entry) =>
                entry.method === "eth_call" &&
                !entry.params[0].to &&
                entry.functionName === "aggregate3",
        ),
    );
    const reads = world.trace.filter((entry) => entry.type === "read");
    assert.ok(
        reads.every(
            (entry) =>
                entry.aggregateCalls.length === 2 &&
                entry.aggregateCalls.every(
                    (call) =>
                        call.success && call.functionName === "getOrderStatus",
                ),
        ),
    );
    assert.equal(reads[1].blockHash, world.ledger.blockAt("A", 104).hash);
    assert.equal(reads[2].blockHash, world.ledger.blockAt("B", 104).hash);
});

test("deployless batches distinguish modeled subcall reverts from unknown fixture inputs", async () => {
    const world = createSimulationWorld({ epochSeconds });
    let captured;
    const client = createPublicClient({
        transport: custom({
            request: ({ method, params }) => {
                captured = params;
                return rpc(world, "default", method, params);
            },
        }),
    });
    const results = await client.multicall({
        deployless: true,
        batchSize: 0,
        allowFailure: true,
        blockNumber: 103n,
        contracts: [
            {
                address: world.ledger.addresses.nft,
                abi: CONTRACT_ABI,
                functionName: "totalSupply",
            },
            {
                address: world.ledger.addresses.nft,
                abi: CONTRACT_ABI,
                functionName: "ownerOf",
                args: [999n],
            },
        ],
    });
    assert.equal(results[0].status, "success");
    assert.equal(results[0].result, 2n);
    assert.equal(results[1].status, "failure");
    await assert.rejects(
        rpc(world, "default", "eth_call", [
            { ...captured[0], data: `0x61${captured[0].data.slice(4)}` },
            captured[1],
        ]),
        (error) => error.code === -32602 && /deployless/.test(error.message),
    );
    await assert.rejects(
        rpc(world, "default", "eth_call", [
            { ...captured[0], data: `${captured[0].data}00` },
            captured[1],
        ]),
        (error) => error.code === -32602 && /malformed/.test(error.message),
    );
    const unsupported = await client.multicall({
        deployless: true,
        batchSize: 0,
        allowFailure: true,
        blockNumber: 103n,
        contracts: [
            {
                address: world.ledger.addresses.nft,
                abi: [
                    {
                        type: "function",
                        name: "unknownFixtureFunction",
                        stateMutability: "view",
                        inputs: [],
                        outputs: [{ type: "uint256" }],
                    },
                ],
                functionName: "unknownFixtureFunction",
            },
        ],
    });
    assert.equal(unsupported[0].status, "failure");
    assert.ok(
        world.trace.some(
            (entry) =>
                entry.type === "error" &&
                /Unknown aggregate contract selector/.test(entry.message),
        ),
    );
});

test("log filtering honors range, addresses and positional OR topics", async () => {
    const world = createSimulationWorld({ epochSeconds });
    world.advanceHead(107);
    const a = world.ledger.addresses;
    const topics = encodeEventTopics({
        abi: TRANSFER_ABI,
        eventName: "Transfer",
    });
    const logs = await rpc(world, "a", "eth_getLogs", [
        {
            address: [a.nft],
            fromBlock: wireQuantity(101),
            toBlock: wireQuantity(104),
            topics: [[topics[0]]],
        },
    ]);
    assert.equal(logs.length, 3);
    assert.deepEqual(
        logs.map((log) => Number(BigInt(log.blockNumber))),
        [101, 102, 104],
    );
    const other = await rpc(world, "b", "eth_getLogs", [
        {
            address: a.nft,
            fromBlock: wireQuantity(104),
            toBlock: wireQuantity(107),
        },
    ]);
    assert.deepEqual(other, []);
});

test("EIP-1898 hash reads reject a divergent provider instead of height fallback", async () => {
    const world = createSimulationWorld({ epochSeconds });
    world.advanceHead(107);
    const canonicalHash = world.ledger.blockAt("A", 104).hash;
    const select = { blockHash: canonicalHash, requireCanonical: true };
    assert.equal(
        (
            await call(
                world,
                "a",
                world.ledger.addresses.nft,
                "ownerOf",
                [1n],
                select,
            )
        ).toLowerCase(),
        world.ledger.addresses.buyer,
    );
    await assert.rejects(
        call(world, "b", world.ledger.addresses.nft, "ownerOf", [1n], select),
        (error) => error.code === -32001,
    );
});

test("scripted A/B/A views expose numeric-read weakness instead of fabricating pinned state", async () => {
    const world = createSimulationWorld({
        epochSeconds,
        providers: { a: { branch: "A", head: 107 } },
        scripts: [
            {
                when: {
                    provider: "a",
                    method: "eth_call",
                    functionName: "ownerOf",
                    occurrence: 1,
                },
                before: { view: { branch: "B" } },
                after: { view: { branch: "A" } },
            },
        ],
    });
    const before = await rpc(world, "a", "eth_getBlockByNumber", [
        "0x68",
        false,
    ]);
    const owner = await call(
        world,
        "a",
        world.ledger.addresses.nft,
        "ownerOf",
        [1n],
    );
    const after = await rpc(world, "a", "eth_getBlockByNumber", [
        "0x68",
        false,
    ]);
    assert.equal(before.hash, after.hash);
    assert.equal(owner.toLowerCase(), world.ledger.addresses.seller);
    const read = world.trace.find(
        (event) => event.type === "read" && event.functionName === "ownerOf",
    );
    assert.equal(read.view.branch, "B");
    assert.notEqual(read.blockHash, before.hash);
    assert.equal(world.snapshot().scripts[0].used, true);
});

test("response barriers retain old wire results while independent requests see a replacement branch", async () => {
    const world = createSimulationWorld({
        epochSeconds,
        providers: { a: { branch: "A", head: 107 } },
        scripts: [
            {
                when: { functionName: "ownerOf", occurrence: 1 },
                after: { barrier: "old-owner" },
            },
        ],
    });
    const first = call(world, "a", world.ledger.addresses.nft, "ownerOf", [1n]);
    await world.waitForBarrier("old-owner");
    assert.equal(world.snapshot().barriers[0].pending, 1);
    world.switchBranch("B");
    const second = await call(
        world,
        "a",
        world.ledger.addresses.nft,
        "ownerOf",
        [1n],
    );
    assert.equal(second.toLowerCase(), world.ledger.addresses.seller);
    world.release("old-owner");
    assert.equal((await first).toLowerCase(), world.ledger.addresses.buyer);
    assert.equal(world.snapshot().barriers[0].pending, 0);
});

test("request barriers defer the actual external read and closing releases pending requests", async () => {
    const world = createSimulationWorld({
        epochSeconds,
        providers: { a: { branch: "A", head: 107 } },
        scripts: [
            {
                when: { functionName: "ownerOf", occurrence: 1 },
                before: { barrier: "before-owner" },
            },
        ],
    });
    const pending = call(world, "a", world.ledger.addresses.nft, "ownerOf", [
        1n,
    ]);
    await world.waitForBarrier("before-owner");
    world.switchBranch("B");
    world.release("before-owner");
    assert.equal((await pending).toLowerCase(), world.ledger.addresses.seller);
    const closed = createSimulationWorld({
        epochSeconds,
        scripts: [
            {
                when: { method: "eth_blockNumber" },
                before: { barrier: "stopped" },
            },
        ],
    });
    const held = rpc(closed, "a", "eth_blockNumber");
    await closed.waitForBarrier("stopped");
    closed.close();
    await assert.rejects(held, /World closed/);
});

test("repeatable status gates exclude the captured old counter and preserve original response evidence", async () => {
    const world = createSimulationWorld({ epochSeconds });
    world.advanceHead(107);
    const a = world.ledger.addresses;
    world.armResponseGate({
        name: "old-counter",
        functionName: GATE_FUNCTION.Counter,
        argument: a.bidder,
    });
    const old = call(
        world,
        "a",
        a.seaport,
        GATE_FUNCTION.Counter,
        [a.bidder],
        "0x69",
    );
    const captured = await world.waitForResponseGate("old-counter");
    assert.equal(captured.captures.length, 1);
    const oldCapture = captured.captures[0];
    assert.equal(oldCapture.matchingCalls[0].result, "1");
    assert.equal(oldCapture.selector, "0x69");
    assert.equal(oldCapture.view.branch, "A");
    assert.equal(oldCapture.blockHash, world.ledger.blockAt("A", 105).hash);
    assert.equal(
        decodeFunctionResult({
            abi: CONTRACT_ABI,
            functionName: GATE_FUNCTION.Counter,
            data: oldCapture.result,
        }),
        1n,
    );
    world.armResponseGate({
        name: "fresh-status",
        functionName: GATE_FUNCTION.OrderStatus,
        argument: world.ledger.orders.bid.orderHash,
    });
    world.switchBranch("B");
    const fresh = [105, 107].map((block) =>
        call(
            world,
            "a",
            a.seaport,
            GATE_FUNCTION.OrderStatus,
            [world.ledger.orders.bid.orderHash],
            wireQuantity(block),
        ),
    );
    await world.waitForResponseGate("fresh-status");
    assert.equal(world.snapshot().responseGates[1].pending, 2);
    assert.equal(
        (await rpc(world, "a", "eth_getBlockByNumber", ["0x69", false])).hash,
        world.ledger.blockAt("B", 105).hash,
    );
    await rpc(world, "a", "eth_getLogs", [
        { fromBlock: "0x65", toBlock: "0x69" },
    ]);
    assert.equal(
        (await call(world, "a", a.nft, "ownerOf", [1n], "0x69")).toLowerCase(),
        a.seller,
    );
    world.releaseResponseGate("old-counter");
    assert.equal(await old, 1n);
    assert.equal(world.snapshot().responseGates[1].pending, 2);
    world.releaseResponseGate("fresh-status");
    assert.deepEqual(await Promise.all(fresh), [
        [false, false, 0n, 1n],
        [false, false, 0n, 1n],
    ]);
    const final = world.snapshot().responseGates;
    assert.equal(final[0].captures.length, 1);
    assert.equal(final[0].captures[0].result, oldCapture.result);
    assert.ok(
        final.every(
            (gate) =>
                gate.pending === 0 &&
                gate.captures.every(
                    (capture) => capture.delivered && !capture.aborted,
                ),
        ),
    );
    assert.ok(
        final[1].captures.every((capture) => capture.view.branch === "B"),
    );
    const released = final[1].events.find(
        (event) => event.type === GATE_EVENT.Released,
    );
    assert.deepEqual(
        released.requestIndexes,
        final[1].captures.map((capture) => capture.requestIndex),
    );
    assert.ok(
        final[1].events
            .filter((event) => event.type === GATE_EVENT.Delivered)
            .every((event) =>
                released.requestIndexes.includes(event.requestIndex),
            ),
    );
    final[0].captures[0].result = "corrupted diagnostic copy";
    assert.equal(
        world.snapshot().responseGates[0].captures[0].result,
        oldCapture.result,
    );
});

test("actual deployless status aggregates are held but ownership-only aggregates stay free", async () => {
    const world = createSimulationWorld({ epochSeconds });
    world.advanceHead(107);
    world.switchBranch("B");
    const a = world.ledger.addresses;
    const client = createPublicClient({
        transport: custom({
            request: ({ method, params }) => rpc(world, "a", method, params),
        }),
    });
    const ownership = {
        address: a.nft,
        abi: CONTRACT_ABI,
        functionName: "ownerOf",
        args: [1n],
    };
    world.armResponseGate({
        name: "bid-status",
        functionName: GATE_FUNCTION.OrderStatus,
        argument: world.ledger.orders.bid.orderHash,
    });
    const batch = (contracts) =>
        client.multicall({
            contracts,
            blockNumber: 105n,
            deployless: true,
            batchSize: 0,
            allowFailure: false,
        });
    assert.equal((await batch([ownership]))[0].toLowerCase(), a.seller);
    assert.equal(world.snapshot().responseGates[0].captures.length, 0);
    const pending = batch([
        ownership,
        {
            address: a.seaport,
            abi: CONTRACT_ABI,
            functionName: GATE_FUNCTION.OrderStatus,
            args: [world.ledger.orders.bid.orderHash],
        },
    ]);
    const gate = await world.waitForResponseGate("bid-status");
    assert.equal(gate.captures[0].matchingCalls.length, 1);
    assert.deepEqual(gate.captures[0].matchingCalls[0].result, [
        false,
        false,
        "0",
        "1",
    ]);
    assert.equal(gate.captures[0].selector, "0x69");
    assert.equal(gate.captures[0].view.branch, "B");
    assert.equal(gate.captures[0].blockNumber, 105);
    assert.ok(gate.captures[0].result.startsWith("0x"));
    world.switchBranch("A");
    assert.equal((await batch([ownership]))[0].toLowerCase(), a.buyer);
    world.releaseResponseGate("bid-status");
    const result = await pending;
    assert.equal(result[0].toLowerCase(), a.seller);
    assert.deepEqual(result[1], [false, false, 0n, 1n]);
    assert.equal(world.snapshot().responseGates[0].captures.length, 1);
});

test("wildcard status gates and explicit aborts cannot leave overlapping replies or empty waiters hanging", async () => {
    const world = createSimulationWorld({ epochSeconds });
    world.armResponseGate({
        name: "all-status",
        functionName: GATE_FUNCTION.OrderStatus,
    });
    world.armResponseGate({
        name: "bid-only",
        functionName: GATE_FUNCTION.OrderStatus,
        argument: world.ledger.orders.bid.orderHash,
    });
    const pending = call(
        world,
        "a",
        world.ledger.addresses.seaport,
        GATE_FUNCTION.OrderStatus,
        [world.ledger.orders.bid.orderHash],
        "0x67",
    );
    await world.waitForResponseGate("bid-only");
    world.abortResponseGate("bid-only");
    await assert.rejects(pending, /response gate aborted before delivery/);
    const gates = world.snapshot().responseGates;
    assert.equal(gates[0].released, false);
    assert.ok(
        gates.every(
            (gate) =>
                gate.pending === 0 &&
                gate.captures[0].aborted &&
                !gate.captures[0].delivered,
        ),
    );
    world.armResponseGate({
        name: "empty-counter",
        functionName: GATE_FUNCTION.Counter,
        argument: world.ledger.addresses.bidder,
    });
    const empty = world.waitForResponseGate("empty-counter");
    world.close();
    await assert.rejects(empty, /response gate aborted/);
    assert.ok(world.snapshot().responseGates.every((gate) => gate.aborted));
});

test("response gates reject ambiguous names, malformed arguments and repeated terminal actions", async () => {
    const world = createSimulationWorld({ epochSeconds });
    for (const options of [
        { name: "unknown-function", functionName: "ownerOf" },
        { name: "missing-maker", functionName: GATE_FUNCTION.Counter },
        {
            name: "wrong-hash",
            functionName: GATE_FUNCTION.OrderStatus,
            argument: world.ledger.addresses.bidder,
        },
        {
            name: "extra",
            functionName: GATE_FUNCTION.OrderStatus,
            before: true,
        },
    ])
        assert.throws(
            () => world.armResponseGate(options),
            /response gate|Response gate/,
        );
    world.armResponseGate({
        name: "valid",
        functionName: GATE_FUNCTION.OrderStatus,
    });
    const empty = world.waitForResponseGate("valid");
    assert.throws(
        () =>
            world.armResponseGate({
                name: "valid",
                functionName: GATE_FUNCTION.OrderStatus,
            }),
        /cannot be reused/,
    );
    assert.throws(
        () => world.releaseResponseGate("unknown"),
        /Unknown external response gate/,
    );
    world.releaseResponseGate("valid");
    await assert.rejects(empty, /released before capture/);
    assert.throws(() => world.releaseResponseGate("valid"), /already released/);
    assert.throws(() => world.abortResponseGate("valid"), /already released/);
    world.close();
    assert.throws(
        () =>
            world.armResponseGate({
                name: "closed",
                functionName: GATE_FUNCTION.OrderStatus,
            }),
        /World is closed/,
    );
});

test("unknown wire work fails closed and contract state is not generic zero data", async () => {
    const world = createSimulationWorld({ epochSeconds });
    world.advanceHead(107);
    const a = world.ledger.addresses;
    assert.equal(
        await call(world, "a", a.weth, "balanceOf", [a.bidder], "0x66"),
        10_000_000_000_000_000_000n,
    );
    assert.equal(
        await call(
            world,
            "a",
            a.weth,
            "allowance",
            [a.bidder, a.seaport],
            "0x66",
        ),
        10_000_000_000_000_000_000n,
    );
    await assert.rejects(
        rpc(world, "a", "eth_sendRawTransaction", ["0x00"]),
        (error) => error.code === -32601,
    );
    await assert.rejects(
        call(world, "a", a.seller, "balanceOf", [a.bidder]),
        /Unsupported balanceOf contract/,
    );
    await assert.rejects(
        rpc(world, "a", "eth_call", [
            { to: a.weth, data: "0x12345678" },
            "latest",
        ]),
        /Unknown contract selector/,
    );
    await assert.rejects(
        call(world, "a", a.seaport, "getOrderStatus", [`0x${"f".repeat(64)}`]),
        /Unknown Seaport order hash/,
    );
    await assert.rejects(
        rpc(world, "unknown", "eth_blockNumber"),
        /Unknown provider/,
    );
    await assert.rejects(
        rpc(world, "a", "eth_call", [{ data: "0x00" }, "latest"]),
        (error) => error.code === -32602,
    );
});

test("wire order/ledger generation replays byte-identically at a declared epoch", async () => {
    const first = createSimulationWorld({ epochSeconds });
    const second = createSimulationWorld({ epochSeconds });
    assert.deepEqual(first.snapshot(), second.snapshot());
    assert.deepEqual(first.ledger.orders, second.ledger.orders);
    assert.deepEqual(
        first.ledger.blockAt("A", 104),
        second.ledger.blockAt("A", 104),
    );
    assert.notEqual(
        first.ledger.orders.listing.orderHash,
        first.ledger.orders.bid.orderHash,
    );
    const changedEpoch = createSimulationWorld({
        epochSeconds: epochSeconds + 1,
    });
    assert.notEqual(
        first.ledger.orders.listing.orderHash,
        changedEpoch.ledger.orders.listing.orderHash,
    );
});

test("transfer-only world separates NFT ownership from protocol fill and explicit counter invalidation", async () => {
    const world = createSimulationWorld({ epochSeconds, transferOnly: true });
    world.advanceHead(107);
    const a = world.ledger.addresses;
    const transfer = world.ledger.blockAt("A", 104);
    assert.equal(transfer.logs.length, 1);
    assert.equal(
        decodeEventLog({
            abi: TRANSFER_ABI,
            ...transfer.logs[0],
        }).args.to.toLowerCase(),
        a.buyer,
    );
    assert.deepEqual(
        await call(world, "a", a.seaport, "getOrderStatus", [
            world.ledger.orders.listing.orderHash,
        ]),
        [false, false, 0n, 1n],
    );
    assert.equal(
        await call(world, "a", a.seaport, "getCounter", [a.bidder], "0x69"),
        1n,
    );
    assert.equal(
        await call(world, "b", a.seaport, "getCounter", [a.bidder], "0x69"),
        0n,
    );
    assert.equal(
        (await call(world, "a", a.nft, "ownerOf", [1n])).toLowerCase(),
        a.buyer,
    );
});

test("fault coverage requires actual injection rather than a matched request blocked beforehand", async () => {
    const blocked = createSimulationWorld({
        epochSeconds,
        scripts: [
            {
                id: "header-error",
                when: { method: "eth_blockNumber" },
                before: { barrier: "before-fault" },
                fault: { code: -32000, message: "Provider unavailable" },
            },
        ],
    });
    const pending = rpc(blocked, "a", "eth_blockNumber");
    await blocked.waitForBarrier("before-fault");
    assert.equal(blocked.snapshot().scripts[0].used, true);
    assert.equal(blocked.snapshot().scripts[0].applied, false);
    blocked.close();
    await assert.rejects(pending, /World closed/);
    assert.ok(!blocked.trace.some((event) => event.type === "fault-injected"));
    const applied = createSimulationWorld({
        epochSeconds,
        scripts: [
            {
                id: "header-error",
                when: { method: "eth_blockNumber" },
                fault: { code: -32000, message: "Provider unavailable" },
            },
        ],
    });
    await assert.rejects(
        rpc(applied, "a", "eth_blockNumber"),
        /Provider unavailable/,
    );
    assert.equal(applied.snapshot().scripts[0].applied, true);
    assert.equal(
        applied.trace.find((event) => event.type === "fault-injected").fault,
        "header-error",
    );
});

test("a declared immutable tail cadence preserves the scripted fork window and empty canonical recovery blocks", () => {
    const world = createSimulationWorld({
        epochSeconds,
        tailBlockIntervalSeconds: 12,
        providers: { default: { branch: "B", head: 103 } },
    });
    const before = JSON.stringify(world.ledger.blockAt("B", 107));
    assert.equal(world.ledger.blockAt("B", 107).timestamp, epochSeconds + 4);
    assert.equal(world.ledger.blockAt("B", 108).timestamp, epochSeconds + 16);
    assert.equal(world.ledger.blockAt("B", 109).timestamp, epochSeconds + 28);
    world.advanceHead(110);
    assert.equal(JSON.stringify(world.ledger.blockAt("B", 107)), before);
    for (let number = 108; number <= 110; number++) {
        const block = world.ledger.blockAt("B", number);
        assert.deepEqual(block.events, []);
        assert.deepEqual(block.logs, []);
        assert.equal(
            block.parentHash,
            world.ledger.blockAt("B", number - 1).hash,
        );
    }
    assert.deepEqual(
        world.ledger.stateAt("B", 110),
        world.ledger.stateAt("B", 107),
    );
    const snapshot = world.snapshot();
    assert.equal(snapshot.maximumBlock, 140);
    assert.equal(snapshot.tailBlockIntervalSeconds, 12);
    const legacy = createSimulationWorld({ epochSeconds });
    assert.equal(legacy.ledger.blockAt("B", 108).timestamp, epochSeconds + 5);
    for (const interval of [null, 0, -1, 61, "12", 12.5])
        assert.throws(
            () =>
                createSimulationWorld({
                    epochSeconds,
                    tailBlockIntervalSeconds: interval,
                }),
            /tail block interval/,
        );
});

test("HTTP metadata repair changes only the external document, never historical tokenURI", async () => {
    const server = await startWorldServer({
        scenario: {
            epochSeconds,
            metadataTransport: METADATA_TRANSPORT.Http,
        },
    });
    try {
        const world = server.world;
        const originalBlock = structuredClone(world.ledger.blockAt("A", 102));
        const uri = await call(
            world,
            "default",
            world.ledger.addresses.nft,
            "tokenURI",
            [1n],
            "0x66",
        );
        assert.equal(uri, `${server.url}/metadata/1`);
        const original = await (await fetch(uri)).text();
        assert.equal(JSON.parse(original).name, "Simulation token 1");
        world.setTokenMetadataDocument("1", "{");
        assert.equal(await (await fetch(uri)).text(), "{");
        assert.equal(
            await call(
                world,
                "default",
                world.ledger.addresses.nft,
                "tokenURI",
                [1n],
                "0x66",
            ),
            uri,
        );
        world.setTokenMetadataDocument("1", original);
        assert.equal(await (await fetch(uri)).text(), original);
        assert.equal(
            await call(
                world,
                "default",
                world.ledger.addresses.nft,
                "tokenURI",
                [1n],
                "0x66",
            ),
            uri,
        );
        assert.deepEqual(world.ledger.blockAt("A", 102), originalBlock);
        assert.equal(
            world.trace.filter(
                (entry) =>
                    entry.type === "http-request" &&
                    entry.path === "/metadata/1",
            ).length,
            3,
        );
        assert.throws(
            () => world.publishMetadataAt(server.url),
            /before the first/,
        );
        assert.throws(
            () => world.setTokenMetadataDocument("3", "{}"),
            /known token/,
        );
    } finally {
        await server.close();
    }
    const unchanged = createSimulationWorld({ epochSeconds });
    const uri = await call(
        unchanged,
        "default",
        unchanged.ledger.addresses.nft,
        "tokenURI",
        [1n],
        "0x66",
    );
    assert.ok(uri.startsWith("data:application/json;base64,"));
    assert.throws(
        () => unchanged.setTokenMetadataDocument("1", "{"),
        /stable external HTTP tokenURI/,
    );
    const secure = createSimulationWorld({
        epochSeconds,
        metadataTransport: METADATA_TRANSPORT.Http,
    });
    secure.publishMetadataAt("https://api.opensea.io:443");
    assert.equal(
        await call(
            secure,
            "default",
            secure.ledger.addresses.nft,
            "tokenURI",
            [1n],
            "0x66",
        ),
        "https://api.opensea.io/metadata/1",
    );
});
