import { expect, it } from "vitest";
import {
    decodeEventLog,
    decodeFunctionData,
    encodeAbiParameters,
    encodeEventTopics,
    encodeFunctionData,
    zeroAddress,
} from "viem";
import {
    BLUR_EXCHANGE_V2_ABI,
    BLUR_EXECUTION_ABI,
    decodeBlurFills,
} from "../src/application/fills/blur.js";
import { readTxDump, toEnhancedTransaction } from "./helpers/tx-dumps.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";

const CONTRACT = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
async function batch() {
    return toEnhancedTransaction(
        await readTxDump(
            import.meta.url,
            "fill-txs",
            "0x406e361a6cc71c62326f0fddb92bfc291459da516b4dc928a789a8b8c7a80416.json",
        ),
    );
}

it("matches the surviving Blur exchange to its own event after filtering", async () => {
    const tx = await batch();
    const original = decodeBlurFills(tx, new Set([CONTRACT]));
    tx.events = tx.events.filter((e) => e.decoded.tokenId === "7235");
    expect(decodeBlurFills(tx, new Set([CONTRACT]))).toEqual([original[1]]);
    expect(original.map((f) => [f.tokenId, f.logIndex, f.orderId])).toEqual([
        [
            "3215",
            286,
            "0xcb838a63a0da333c85fbec3e02d9701d18f52cff78fc6b815c09997ea1d820e4",
        ],
        [
            "7235",
            287,
            "0x5e9e2dac05b501f20ef1655ceaa590aaa85f94d2970e28d8867b924b191dd7d5",
        ],
    ]);
});

it("does not borrow another exchange's event when a batch exchange fails", async () => {
    const tx = await batch();
    const original = decodeBlurFills(tx, new Set([CONTRACT]));
    tx.receiptLogs = tx.receiptLogs
        .filter((log) => log.logIndex !== 286)
        .reverse();
    expect(decodeBlurFills(tx, new Set([CONTRACT]))).toEqual([original[1]]);
});

it.each(["Execution721MakerFeePacked", "Execution721TakerFeePacked"] as const)(
    "recognizes successful %s events",
    async (eventName) => {
        const tx = await batch();
        const original = decodeBlurFills(tx, new Set([CONTRACT]));
        const log = tx.receiptLogs.find((log) => log.logIndex === 286)!;
        const decoded = decodeEventLog({
            abi: BLUR_EXECUTION_ABI,
            eventName: "Execution721Packed",
            data: log.data,
            topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });
        const event = BLUR_EXECUTION_ABI.find((e) => e.name === eventName)!;
        log.topics = encodeEventTopics({
            abi: BLUR_EXECUTION_ABI,
            eventName,
        }) as `0x${string}`[];
        log.data = encodeAbiParameters(event.inputs, [
            decoded.args.orderHash,
            decoded.args.tokenIdListingIndexTrader,
            decoded.args.collectionPriceSide,
            100n,
        ]);
        expect(
            decodeBlurFills(tx, new Set([CONTRACT])).map(
                ({ execution, ...fill }) => fill,
            ),
        ).toEqual(original.map(({ execution, ...fill }) => fill));
    },
);

it("uses the actually executed ERC1155 quantity and gross total from Execution", async () => {
    const tx = await batch();
    const decoded = decodeFunctionData({
        abi: BLUR_EXCHANGE_V2_ABI,
        data: tx.transaction.input,
    });
    // Assert the supported takeAsk wire serialization, independently of decoder helpers.
    expect(decoded.functionName).toBe("takeAsk");
    const input = decoded.args[0] as any;
    const order = { ...input.orders[0], assetType: 1 };
    const exchange = {
        ...input.exchanges[0],
        listing: { ...input.exchanges[0].listing, amount: 5n },
        taker: { ...input.exchanges[0].taker, amount: 3n },
    };
    tx.transaction.input = encodeFunctionData({
        abi: BLUR_EXCHANGE_V2_ABI,
        functionName: "takeAsk",
        args: [
            { ...input, orders: [order], exchanges: [exchange] },
            decoded.args[1],
        ],
    });
    const log = tx.receiptLogs.find((log) => log.logIndex === 286)!;
    const event = BLUR_EXECUTION_ABI.find((e) => e.name === "Execution")!;
    const noFee = { recipient: zeroAddress, rate: 0 };
    const total = exchange.listing.price * 3n;
    tx.events = tx.events
        .filter((event) => event.decoded.tokenId === "3215")
        .map((event) => ({
            ...event,
            kind: COLLECTION_STANDARD.Erc1155,
            decoded: {
                ...event.decoded,
                standard: COLLECTION_STANDARD.Erc1155,
                amount: "3",
            },
        }));
    log.topics = encodeEventTopics({
        abi: BLUR_EXECUTION_ABI,
        eventName: "Execution",
    }) as `0x${string}`[];
    log.data = encodeAbiParameters(event.inputs, [
        {
            trader: order.trader,
            id: exchange.taker.tokenId,
            amount: 3n,
            collection: order.collection,
            assetType: 1,
        },
        `0x${order.salt.toString(16).padStart(64, "0")}`,
        exchange.listing.index,
        total,
        noFee,
        { protocolFee: noFee, takerFee: noFee },
        0,
    ]);
    expect(decodeBlurFills(tx, new Set([CONTRACT]))).toMatchObject([
        {
            tokenId: "3215",
            amount: "3",
            price: total.toString(),
            executionItemIndex: 0,
            logIndex: 286,
        },
    ]);
    // A contradicted quote cannot turn an unrelated execution into a price.
    exchange.listing.price += 1n;
    tx.transaction.input = encodeFunctionData({
        abi: BLUR_EXCHANGE_V2_ABI,
        functionName: "takeAsk",
        args: [
            { ...input, orders: [order], exchanges: [exchange] },
            decoded.args[1],
        ],
    });
    expect(decodeBlurFills(tx, new Set([CONTRACT]))).toEqual([]);
});
