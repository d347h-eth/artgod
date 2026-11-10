import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeFunctionData, decodeFunctionResult } from "viem";
import { normalizeOpenSeaRestOrder } from "../../../indexer/src/application/offchain/opensea-rest-normalize.ts";
import {
    normalizeOpenSeaEvent,
    normalizeOpenSeaOrderUpdate,
} from "../../../indexer/src/application/offchain/opensea-normalize.ts";
import { createSeaportOrderValidationFactory } from "../../../indexer/src/application/offchain/seaport-validation-batch.ts";
import { OPENSEA_REST_EVENT_TYPE } from "../../../indexer/src/domain/offchain-jobs.ts";
import {
    ORDER_STATUS,
    ORDER_SOURCE_STATUS,
} from "../../../indexer/src/domain/orders.ts";
import { createSimulationWorld } from "./world.mjs";
import { wireQuantity } from "./wire.mjs";
import { RESPONSE_GATE_FUNCTION } from "./contract.mjs";

// Compatibility only: actual production parsers/validator consume fixture wire.
// This is not a replacement for the guest's real runtime/NATS/SQLite journey.
test("signed REST and Phoenix payloads pass owning production normalizers", async () => {
    const world = createSimulationWorld({ epochSeconds: 1_800_000_000 });
    await world.signMarketOrders();
    for (const [name, recordType] of [
        ["listing", OPENSEA_REST_EVENT_TYPE.Listing],
        ["bid", OPENSEA_REST_EVENT_TYPE.ItemOffer],
    ]) {
        const prepared = world.ledger.orders[name];
        const rest = normalizeOpenSeaRestOrder(recordType, prepared.raw);
        const stream = normalizeOpenSeaEvent(
            world.streamEventFor(name).payload,
        );
        assert.ok(rest);
        assert.ok(stream);
        for (const normalized of [rest, stream]) {
            assert.equal(normalized.orderId, prepared.orderHash);
            assert.equal(normalized.side, prepared.side);
            assert.equal(normalized.tokenId, prepared.tokenId);
            assert.equal(normalized.maker.toLowerCase(), prepared.maker);
            assert.equal(normalized.price, "1000000000000000000");
            assert.equal(normalized.seaportData.signature.length, 132);
        }
    }
});

test("the cancellation fixture reaches the production lifecycle normalizer without fabricating protocol state", () => {
    const world = createSimulationWorld({ epochSeconds: 1_800_000_000 });
    const event = world.cancellationEventFor("bid", {
        observedAt: 1_800_000_001,
    });
    const result = normalizeOpenSeaOrderUpdate(event.payload);
    assert.equal(result.orderId, world.ledger.orders.bid.orderHash);
    assert.equal(result.sourceStatus, ORDER_SOURCE_STATUS.Cancelled);
    assert.equal(result.validUntil, 1_800_086_400);
    assert.equal(
        world.ledger.stateAt("A", 103).statuses.has(result.orderId),
        false,
    );
});

test("actual full snapshot validates signed untouched orders, protocol terminals and corrupt signatures", async () => {
    const world = createSimulationWorld();
    await world.signMarketOrders();
    const request = (method, params = []) =>
        world.handleRpc("default", { jsonrpc: "2.0", id: 1, method, params });
    const statusResults = [];
    const readContract = async (
        { address, abi, functionName, args },
        selector,
    ) => {
        const data = encodeFunctionData({ abi, functionName, args });
        const value = await request("eth_call", [
            { to: address, data },
            selector,
        ]);
        const result = decodeFunctionResult({
            abi,
            functionName,
            data: value,
        });
        if (functionName === RESPONSE_GATE_FUNCTION.OrderStatus)
            statusResults.push(result);
        return result;
    };
    const port = {
        getBlockNumber: async () =>
            Number(BigInt(await request("eth_blockNumber"))),
        getBlock: async (number) => {
            const raw = await request("eth_getBlockByNumber", [
                wireQuantity(number),
                false,
            ]);
            return {
                number: Number(BigInt(raw.number)),
                hash: raw.hash,
                parentHash: raw.parentHash,
                timestamp: Number(BigInt(raw.timestamp)),
                transactions: raw.transactions,
            };
        },
        readContract: ({ blockNumber, ...contract }) =>
            readContract(
                contract,
                blockNumber === undefined
                    ? "latest"
                    : wireQuantity(blockNumber),
            ),
        readContractAtBlock: ({ block, ...contract }) =>
            readContract(contract, {
                blockHash: block.blockHash,
                requireCanonical: true,
            }),
    };
    const createSnapshot = createSeaportOrderValidationFactory({
        chainId: 1,
        rpc: port,
        conduits: {
            getConduit() {
                throw new Error("Zero conduit key must not read registry");
            },
            upsertConduit() {
                throw new Error("Zero conduit key must not write registry");
            },
            hasChannel() {
                throw new Error("Zero conduit key must not read channel");
            },
            replaceChannels() {
                throw new Error("Zero conduit key must not write channel");
            },
        },
        conduitController: world.ledger.addresses.conduitController,
    });
    const orders = [];
    for (const [name, recordType] of [
        ["listing", OPENSEA_REST_EVENT_TYPE.Listing],
        ["bid", OPENSEA_REST_EVENT_TYPE.ItemOffer],
    ]) {
        const normalized = normalizeOpenSeaRestOrder(
            recordType,
            world.ledger.orders[name].raw,
        );
        const order = {
            ...normalized,
            id: normalized.orderId,
            chainId: 1,
            collectionId: 1,
        };
        orders.push(order);
        const snapshot = await createSnapshot({
            chainId: 1,
            minimumBlock: null,
            candidates: [order],
        });
        assert.equal(
            (await snapshot.validate(order)).status,
            ORDER_STATUS.Fillable,
        );
        await snapshot.finish();
        const corrupted = structuredClone(order);
        corrupted.seaportData.signature = "0x00";
        const invalidSnapshot = await createSnapshot({
            chainId: 1,
            minimumBlock: null,
            candidates: [corrupted],
        });
        assert.equal(
            (await invalidSnapshot.validate(corrupted)).status,
            ORDER_STATUS.Invalid,
        );
        await invalidSnapshot.finish();
    }
    // A 0/0 untouched order must reach ownership/funding checks, rather than
    // being mistaken for a completed fill by the production validator.
    assert.deepEqual(statusResults, [
        [false, false, 0n, 0n],
        [false, false, 0n, 0n],
    ]);
    for (const [block, order, status, protocolStatus] of [
        [104, orders[0], ORDER_STATUS.Filled, [true, false, 1n, 1n]],
        [105, orders[1], ORDER_STATUS.Cancelled, [false, false, 0n, 0n]],
    ]) {
        world.advanceHead(block);
        const snapshot = await createSnapshot({
            chainId: 1,
            minimumBlock: null,
            candidates: [order],
        });
        assert.equal((await snapshot.validate(order)).status, status);
        await snapshot.finish();
        assert.deepEqual(statusResults.at(-1), protocolStatus);
    }
    assert.ok(world.trace.some((entry) => entry.functionName === "ownerOf"));
    assert.ok(world.trace.some((entry) => entry.functionName === "balanceOf"));
    assert.ok(world.trace.some((entry) => entry.functionName === "allowance"));
});
