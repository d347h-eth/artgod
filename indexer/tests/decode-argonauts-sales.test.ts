import { describe, expect, it } from "vitest";
import {
    FILL_PRICE_EXCLUSION,
    summarizeFillPayment,
} from "@artgod/shared/market-data/fills";
import {
    decodeEventLog,
    encodeAbiParameters,
    encodeEventTopics,
    zeroAddress,
} from "viem";
import {
    decodeSeaportFills,
    SEAPORT_ORDER_FULFILLED_ABI,
} from "../src/application/fills/seaport.js";
import type { EnhancedTransaction } from "../src/domain/onchain.js";
import type { RpcLog } from "../src/ports/rpc.js";
import { readTxDump, toEnhancedTransaction } from "./helpers/tx-dumps.js";

const ARGONAUTS_CONTRACT = "0x387c41b0b2f1128de44db1bcf8baad085f26392c";
const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const FORWARDED_NATIVE_TX =
    "0x47f2bf2e7e65802e83a8a21d198f8b1599d264f2d062ea727329eb7d15eb0cfb";
const collections = new Set([ARGONAUTS_CONTRACT]);
const [orderFulfilledTopic] = encodeEventTopics({
    abi: SEAPORT_ORDER_FULFILLED_ABI,
    eventName: "OrderFulfilled",
});

async function readTransaction(hash: string) {
    return toEnhancedTransaction(
        await readTxDump(import.meta.url, "fill-txs/argonauts", hash + ".json"),
    );
}

describe("Seaport matched orders with forwarded NFT consideration", () => {
    it.each([
        {
            hash: FORWARDED_NATIVE_TX,
            tokenId: "3109",
            maker: "0x03ee832367e29a5cd001f65093283eabb5382b62",
            taker: "0xb5118112c02c08ceefe22feffbf3148f4376c43e",
            price: "13000000000000000000",
            currency: zeroAddress,
            logIndex: 97,
        },
        {
            hash: "0x2e6abf2f9665fe405715588d5635cf532bad7dee85ec94995d690149b5aa3c1e",
            tokenId: "2362",
            maker: "0xc0ee8c18f0709d9d651fe90d30d0392d443f2459",
            taker: "0x0b7ab69c5f1378a074a9a9c0f4c83a35124bc5a8",
            price: "600000000000000000",
            currency: zeroAddress,
            logIndex: 476,
        },
        {
            hash: "0x83d35199e322fe088d1f3f6fc882fd895b7cdc8a7889d026ea7b6a5c3e9a9c9e",
            tokenId: "2959",
            maker: "0xa27be4084d7548d8019931877dd9bb75cc028696",
            taker: "0xcb2e8c6866b2b68a70197359e76ae594ed307d7e",
            price: "1350000000000000064",
            currency: WETH_ADDRESS,
            logIndex: 990,
        },
    ])("keeps one exact sale for $hash", async ({ hash, ...expected }) => {
        const tx = await readTransaction(hash);
        const fills = decodeSeaportFills(tx, collections);
        expect(fills).toHaveLength(1);
        expect(fills[0]).toMatchObject({
            ...expected,
            contract: ARGONAUTS_CONTRACT,
            txHash: hash,
            orderSide: "sell",
            amount: "1",
        });
    });

    it("requires an actual NFT transfer", async () => {
        const tx = await readTransaction(FORWARDED_NATIVE_TX);
        tx.events = [];
        expect(decodeSeaportFills(tx, collections)).toEqual([]);
    });

    it.each<{
        name: string;
        mutate: (args: FulfillmentArgs) => FulfillmentArgs;
    }>([
        {
            name: "a different token on the opposite leg",
            mutate: (args) => ({
                ...args,
                consideration: args.consideration.map((item) =>
                    item.itemType === 2
                        ? { ...item, identifier: item.identifier + 1n }
                        : item,
                ),
            }),
        },
        {
            name: "a different NFT quantity on the opposite leg",
            mutate: (args) => ({
                ...args,
                consideration: args.consideration.map((item) =>
                    item.itemType === 2 ? { ...item, amount: 2n } : item,
                ),
            }),
        },
        {
            name: "an additional untracked NFT swap leg",
            mutate: (args) => ({
                ...args,
                consideration: [
                    ...args.consideration,
                    {
                        ...args.consideration.find(
                            (item) => item.itemType === 2,
                        )!,
                        token: WETH_ADDRESS,
                    },
                ],
            }),
        },
        {
            name: "forwarding without payment",
            mutate: (args) => ({
                ...args,
                consideration: args.consideration.filter(
                    (item) => item.itemType === 2,
                ),
            }),
        },
    ])("retains $name as unpriced facts", async ({ mutate }) => {
        const tx = await readTransaction(FORWARDED_NATIVE_TX);
        rewriteFulfillment(tx, mutate);
        const fills = decodeSeaportFills(tx, collections);
        expect(fills.length).toBeGreaterThan(0);
        for (const fill of fills) {
            expect(fill.price).toBeUndefined();
            expect(summarizeFillPayment(fill.execution.items).exclusion).toBe(
                FILL_PRICE_EXCLUSION.Swap,
            );
        }
    });
});

function decodeFulfillment(log: RpcLog) {
    return decodeEventLog({
        abi: SEAPORT_ORDER_FULFILLED_ABI,
        eventName: "OrderFulfilled",
        data: log.data,
        topics: log.topics as [typeof log.data, ...(typeof log.data)[]],
    });
}

type FulfillmentArgs = ReturnType<typeof decodeFulfillment>["args"];

function rewriteFulfillment(
    tx: EnhancedTransaction,
    mutate: (args: FulfillmentArgs) => FulfillmentArgs,
) {
    const log = tx.receiptLogs.find(
        (candidate) => candidate.topics[0] === orderFulfilledTopic,
    )!;
    const args = mutate(decodeFulfillment(log).args);
    log.data = encodeAbiParameters(
        SEAPORT_ORDER_FULFILLED_ABI[0].inputs.filter((input) => !input.indexed),
        [args.orderHash, args.recipient, args.offer, args.consideration],
    );
}
