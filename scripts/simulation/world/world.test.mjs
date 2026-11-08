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
        /deployless EVM execution unavailable/,
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
