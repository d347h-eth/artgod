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

test("actual full snapshot validates both signed fixture orders and rejects corrupt signature", async () => {
    const world = createSimulationWorld();
    await world.signMarketOrders();
    const request = (method, params = []) =>
        world.handleRpc("default", { jsonrpc: "2.0", id: 1, method, params });
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
        readContract: async ({
            address,
            abi,
            functionName,
            args,
            blockNumber,
        }) => {
            const data = encodeFunctionData({ abi, functionName, args });
            const value = await request("eth_call", [
                { to: address, data },
                blockNumber === undefined
                    ? "latest"
                    : wireQuantity(blockNumber),
            ]);
            return decodeFunctionResult({ abi, functionName, data: value });
        },
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
    assert.ok(world.trace.some((entry) => entry.functionName === "ownerOf"));
    assert.ok(world.trace.some((entry) => entry.functionName === "balanceOf"));
    assert.ok(world.trace.some((entry) => entry.functionName === "allowance"));
});
