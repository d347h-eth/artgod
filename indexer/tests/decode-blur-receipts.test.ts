import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, zeroAddress } from "viem";
import {
    FILL_KIND,
    fillExecutionIdentity,
    summarizeFillPayment,
    allocateFillPayment,
} from "@artgod/shared/market-data/fills";
import {
    BLUR_ASSET_TYPE,
    BLUR_BETH_ADDRESS,
    BLUR_EXECUTION_EVENT_ABI,
    BLUR_EXECUTION_EVENT_NAME,
    BLUR_ORDER_TYPE,
    decodeBlurFills,
} from "../src/application/fills/blur.js";
import { COLLECTION_STANDARD } from "../src/domain/collections.js";
import type { EnhancedTransaction } from "../src/domain/onchain.js";
import type { Hex } from "../src/ports/rpc.js";
import { readTxDump, toEnhancedTransaction } from "./helpers/tx-dumps.js";

const ROUTED_ASK_BATCH =
    "0x14be04e98cbe409dc602ca208c8d3c5fefeff89892ff776042c6b540be68a7bd";
const POOL_ASK_BATCH =
    "0xbe27fe81487e69e1bbb49701f13317469929e3eb2b1165533cf3cdbae51313b1";
const ROUTED_POOL_ASK =
    "0x8a952b2c66632fafd81766f953608b4504621ab39162c45db9ae6a1e57fc90e2";
const [packedTopic] = encodeEventTopics({
    abi: BLUR_EXECUTION_EVENT_ABI,
    eventName: BLUR_EXECUTION_EVENT_NAME.Packed,
});

async function readTransaction(hash: string) {
    return toEnhancedTransaction(
        await readTxDump(import.meta.url, "fill-txs/argonauts", hash + ".json"),
    );
}

function trackedContracts(tx: EnhancedTransaction) {
    return new Set(tx.events.map((event) => event.base.contract.toLowerCase()));
}

describe("Blur V2 receipt executions", () => {
    it("decodes each routed ask with its exact execution identity", async () => {
        const tx = await readTransaction(ROUTED_ASK_BATCH);
        expect(decodeBlurFills(tx, trackedContracts(tx))).toMatchObject([
            {
                tokenId: "1156",
                price: "859999000000000000",
                currency: zeroAddress,
                orderSide: "sell",
                logIndex: 306,
                orderId:
                    "0x1735cbc09abc43442c93547b461737ef0da03f9395090373c135aaf144673065",
            },
            {
                tokenId: "9377",
                price: "859980000000000000",
                currency: zeroAddress,
                orderSide: "sell",
                logIndex: 307,
                orderId:
                    "0x925abe8900f1aaf1b6470d047b3a31c085f019934a9f90e0d2df01a82f470d41",
            },
        ]);
    });

    it("decodes pool-funded ask batches as ETH executions", async () => {
        const tx = await readTransaction(POOL_ASK_BATCH);
        const fills = decodeBlurFills(tx, trackedContracts(tx));
        expect(
            fills.map(({ tokenId, price, currency, logIndex }) => ({
                tokenId,
                price,
                currency,
                logIndex,
            })),
        ).toEqual([
            {
                tokenId: "2970",
                price: "163999000000000000",
                currency: zeroAddress,
                logIndex: 802,
            },
            {
                tokenId: "5435",
                price: "164000000000000000",
                currency: zeroAddress,
                logIndex: 803,
            },
            {
                tokenId: "7033",
                price: "163999000000000000",
                currency: zeroAddress,
                logIndex: 804,
            },
        ]);
        expect(
            new Set(
                fills.map((fill) =>
                    fillExecutionIdentity(
                        1,
                        FILL_KIND.BlurV2,
                        fill.txHash,
                        fill.logIndex,
                    ),
                ),
            ).size,
        ).toBe(3);
        for (const fill of fills) {
            expect(fill.executionItemIndex).toBe(0);
            expect(summarizeFillPayment(fill.execution.items)).toEqual({
                exclusion: null,
                totalPrice: fill.price,
                currency: zeroAddress,
                nftQuantity: "1",
            });
        }
    });

    it("decodes routed pool-funded asks without router calldata", async () => {
        const tx = await readTransaction(ROUTED_POOL_ASK);
        tx.transaction.input = "0x";
        expect(decodeBlurFills(tx, trackedContracts(tx))).toMatchObject([
            {
                tokenId: "116",
                orderSide: "sell",
                price: "250000000000000000",
                currency: zeroAddress,
                maker: "0x3a3b180a7eb906d808a999148a81128543efc5bc",
                taker: "0x5802e0c5e3a0d87f9de0be710add41c54b4f1eb4",
                logIndex: 32,
            },
        ]);
    });

    it("keeps the later execution identity after collection filtering", async () => {
        const tx = await readTransaction(ROUTED_ASK_BATCH);
        const collections = trackedContracts(tx);
        const transfer = tx.events.find(
            (event) => event.decoded.tokenId === "1156",
        )!;
        transfer.base.contract = zeroAddress;
        const firstExecution = tx.receiptLogs.find(
            (log) => log.logIndex === 306,
        )!;
        // Deliberately alter the collection's serialized low 160 bits at the wire boundary.
        const words = firstExecution.data.slice(2).match(/.{64}/g)!;
        words[2] = words[2]!.slice(0, 24) + "0".repeat(40);
        firstExecution.data = ("0x" + words.join("")) as Hex;
        const fills = decodeBlurFills(tx, collections);
        expect(fills).toHaveLength(1);
        expect(fills[0]).toMatchObject({
            tokenId: "9377",
            logIndex: 307,
            orderId:
                "0x925abe8900f1aaf1b6470d047b3a31c085f019934a9f90e0d2df01a82f470d41",
        });
    });

    it("requires execution logs rather than counting calldata inputs", async () => {
        const tx = await readTransaction(POOL_ASK_BATCH);
        tx.receiptLogs = tx.receiptLogs.filter((log) => log.logIndex !== 803);
        expect(
            decodeBlurFills(tx, trackedContracts(tx)).map(
                (fill) => fill.tokenId,
            ),
        ).toEqual(["2970", "7033"]);
    });

    it.each([
        "unknown emitter",
        "missing NFT transfer",
        "wrong maker",
        "malformed event",
    ])("rejects %s", async (failure) => {
        const tx = await readTransaction(ROUTED_POOL_ASK);
        const collections = trackedContracts(tx);
        const log = tx.receiptLogs.find(
            (candidate) => candidate.topics[0] === packedTopic,
        )!;
        if (failure === "unknown emitter") log.address = zeroAddress;
        if (failure === "missing NFT transfer") tx.events = [];
        if (failure === "wrong maker") tx.events[0]!.decoded.from = zeroAddress;
        if (failure === "malformed event") log.data = "0x";
        expect(decodeBlurFills(tx, collections)).toEqual([]);
    });

    it.each([
        BLUR_EXECUTION_EVENT_NAME.MakerFeePacked,
        BLUR_EXECUTION_EVENT_NAME.TakerFeePacked,
    ])(
        "decodes %s without losing price or order identity",
        async (eventName) => {
            const tx = await readTransaction(ROUTED_POOL_ASK);
            const expected = decodeBlurFills(tx, trackedContracts(tx));
            const log = tx.receiptLogs.find(
                (candidate) => candidate.topics[0] === packedTopic,
            )!;
            log.topics = encodeEventTopics({
                abi: BLUR_EXECUTION_EVENT_ABI,
                eventName,
            }) as Hex[];
            // The packed fee variants append a fee word to the same execution facts.
            log.data = (log.data + "0".repeat(64)) as Hex;
            expect(decodeBlurFills(tx, trackedContracts(tx))).toEqual(expected);
        },
    );

    it.each([BLUR_ASSET_TYPE.Erc721, BLUR_ASSET_TYPE.Erc1155])(
        "decodes uncompressed asset type %s with full token ID and quantity",
        async (assetType) => {
            const tx = await readTransaction(ROUTED_POOL_ASK);
            const collections = trackedContracts(tx);
            const transfer = tx.events[0]!;
            const tokenId = 2n ** 200n;
            transfer.decoded.tokenId = tokenId.toString();
            transfer.decoded.standard =
                assetType === BLUR_ASSET_TYPE.Erc721
                    ? COLLECTION_STANDARD.Erc721
                    : COLLECTION_STANDARD.Erc1155;
            transfer.decoded.amount =
                assetType === BLUR_ASSET_TYPE.Erc721 ? "1" : "3";
            const log = tx.receiptLogs.find(
                (candidate) => candidate.topics[0] === packedTopic,
            )!;
            const abi = BLUR_EXECUTION_EVENT_ABI.find(
                (event) => event.name === BLUR_EXECUTION_EVENT_NAME.Unpacked,
            )!;
            const fee = { recipient: zeroAddress, rate: 0 };
            log.topics = encodeEventTopics({
                abi: BLUR_EXECUTION_EVENT_ABI,
                eventName: BLUR_EXECUTION_EVENT_NAME.Unpacked,
            }) as Hex[];
            log.data = encodeAbiParameters(abi.inputs, [
                {
                    trader: transfer.decoded.to as Hex,
                    id: tokenId,
                    amount: assetType === BLUR_ASSET_TYPE.Erc721 ? 0n : 3n,
                    collection: transfer.base.contract as Hex,
                    assetType,
                },
                ("0x" + "ab".repeat(32)) as Hex,
                400n,
                900000000000000000n,
                fee,
                { protocolFee: fee, takerFee: fee },
                BLUR_ORDER_TYPE.Bid,
            ]);
            const fills = decodeBlurFills(tx, collections);
            expect(fills).toHaveLength(1);
            expect(fills[0]).toMatchObject({
                tokenId: tokenId.toString(),
                amount: transfer.decoded.amount,
                price: "900000000000000000",
                orderSide: "buy",
                currency: BLUR_BETH_ADDRESS,
                maker: transfer.decoded.to.toLowerCase(),
                taker: transfer.decoded.from.toLowerCase(),
            });
            const payment = summarizeFillPayment(fills[0]!.execution.items);
            expect(payment).toEqual({
                exclusion: null,
                totalPrice: "900000000000000000",
                currency: BLUR_BETH_ADDRESS,
                nftQuantity: transfer.decoded.amount,
            });
            expect(
                allocateFillPayment(
                    payment.totalPrice!,
                    payment.nftQuantity,
                    transfer.decoded.amount,
                    "0",
                ),
            ).toMatchObject({
                unitPrice: {
                    numeratorWei: payment.totalPrice,
                    denominator: transfer.decoded.amount,
                },
                attributedPrice: payment.totalPrice,
            });
        },
    );
});
