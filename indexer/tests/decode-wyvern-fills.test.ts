import { describe, expect, it } from "vitest";
import {
    decodeFunctionData,
    encodeAbiParameters,
    encodeEventTopics,
    encodeFunctionData,
    zeroAddress,
    type Hex,
} from "viem";
import {
    allocateFillPayment,
    FILL_KIND,
    FILL_ITEM_TYPE,
    prepareFillExecution,
    summarizeFillPayment,
} from "@artgod/shared/market-data/fills";
import { ORDER_SIDE } from "@artgod/shared/market-data/orders";
import {
    ERC1155_ABI,
    ERC1155_EVENT_NAME,
    ERC1155_TRANSFER_ABI,
    ERC721_ABI,
    ERC721_EVENT_NAME,
    ERC721_TRANSFER_ABI,
    NFT_TRANSFER_FUNCTION_NAME,
} from "../src/abi/index.js";
import { decodeWyvernFills } from "../src/application/fills/wyvern.js";
import {
    WYVERN_ATOMICIZER_ABI,
    WYVERN_CALL_TYPE,
    WYVERN_EXCHANGE_ABI,
    WYVERN_EXCHANGE_ADDRESS,
    WYVERN_FUNCTION_NAME,
    WYVERN_GENIE_BUY_SELECTOR,
    WYVERN_NFT_FUNCTION_NAME,
    WYVERN_NFT_TARGET_ADDRESS,
    WYVERN_ROUTER_ABI,
    WYVERN_ROUTER_FUNCTION_NAME,
} from "../src/application/fills/wyvern-abi.js";
import type { EnhancedTransaction } from "../src/domain/onchain.js";
import {
    readWyvernTransaction,
    WYVERN_DIRECT_SALES,
    WYVERN_FIXTURE,
    WYVERN_FIXTURE_CONTRACT,
} from "./helpers/wyvern.js";
import { WYVERN_PACKED_HELPER_ADDRESS } from "../src/application/fills/wyvern-packed.js";
import { WYVERN_ROUTER_ADDRESS } from "../src/application/fills/wyvern-abi.js";

const collections = new Set([WYVERN_FIXTURE_CONTRACT]);
const UNTRACKED = "0x0000000000000000000000000000000000000abc";

describe("Wyvern receipt executions", () => {
    it.each(WYVERN_DIRECT_SALES)(
        "decodes $hash with its protocol, side and settlement currency",
        async (sale) => {
            const tx = await readWyvernTransaction(import.meta.url, sale.hash);
            const fills = decodeWyvernFills(tx, collections);
            expect(fills).toHaveLength(1);
            expect(fills[0]).toMatchObject({
                kind: FILL_KIND.Wyvern,
                contract: WYVERN_FIXTURE_CONTRACT,
                tokenId: sale.tokenId,
                amount: "1",
                price: sale.price,
                currency: sale.currency,
                orderSide: sale.orderSide,
                logIndex: sale.logIndex,
                executionItemIndex: 0,
                execution: { protocolAddress: sale.protocol },
            });
            expect(summarizeFillPayment(fills[0]!.execution.items)).toEqual({
                exclusion: null,
                totalPrice: sale.price,
                currency: sale.currency,
                nftQuantity: "1",
            });
            expect(fills[0]!.orderId).toMatch(/^0x[0-9a-f]{64}$/i);
            expect(fills[0]!.orderId).not.toBe("0x" + "00".repeat(32));
        },
    );

    it("retains a true two-NFT bundle as one complete execution", async () => {
        const fills = decodeWyvernFills(
            await readWyvernTransaction(import.meta.url, WYVERN_FIXTURE.Bundle),
            collections,
        );
        expect(
            fills.map((fill) => [
                fill.tokenId,
                fill.executionItemIndex,
                fill.logIndex,
            ]),
        ).toEqual([
            ["135", 0, 714],
            ["589", 1, 714],
        ]);
        expect(fills[0]!.execution).toBe(fills[1]!.execution);
        expect(summarizeFillPayment(fills[0]!.execution.items)).toEqual({
            exclusion: null,
            totalPrice: "1350000000000000000",
            currency: zeroAddress,
            nftQuantity: "2",
        });
        expect(
            allocateFillPayment("1350000000000000000", "2", "1", "0")
                .attributedPrice,
        ).toBe("675000000000000000");
    });

    it("decodes Gem's nested Wyvern purchase without using its outer funding token", async () => {
        const fills = decodeWyvernFills(
            await readWyvernTransaction(import.meta.url, WYVERN_FIXTURE.Gem),
            collections,
        );
        expect(fills).toHaveLength(1);
        expect(fills[0]).toMatchObject({
            kind: FILL_KIND.Wyvern,
            currency: zeroAddress,
            orderSide: ORDER_SIDE.Sell,
        });
    });

    it("keeps Genie's independent purchases and actual recipients separate from the protocol taker", async () => {
        // Deliberately assert the library's onchain wire selector, which differs
        // from the ordinary contract tuple selector for the same argument ABI.
        expect(WYVERN_GENIE_BUY_SELECTOR).toBe("0xb35643cb");
        const fills = decodeWyvernFills(
            await readWyvernTransaction(import.meta.url, WYVERN_FIXTURE.Genie),
            collections,
        );
        expect(fills).toHaveLength(13);
        expect(new Set(fills.map((fill) => fill.logIndex)).size).toBe(13);
        for (const fill of fills) {
            expect(fill.taker).toBe(WYVERN_ROUTER_ADDRESS.Genie);
            expect(fill.execution.items[0]!.recipient).toBe(
                "0xdedb005ff85a036770acb2c3be0fb74d4ff4e465",
            );
            expect(summarizeFillPayment(fill.execution.items).nftQuantity).toBe(
                "1",
            );
        }
    });

    it("unwraps a relayed Argent guardian multicall", async () => {
        const fills = decodeWyvernFills(
            await readWyvernTransaction(import.meta.url, WYVERN_FIXTURE.Argent),
            collections,
        );
        expect(fills).toHaveLength(1);
        expect(fills[0]).toMatchObject({
            tokenId: "5122",
            currency: zeroAddress,
            price: "750000000000000000",
            taker: "0x26efa48f71252f2f7d6c3927e615e6dfaa96b85d",
        });
    });

    it.each([
        {
            hash: WYVERN_FIXTURE.PackedV22,
            count: 1,
            helper: WYVERN_PACKED_HELPER_ADDRESS.V22,
        },
        {
            hash: WYVERN_FIXTURE.PackedV23,
            count: 2,
            helper: WYVERN_PACKED_HELPER_ADDRESS.V23,
        },
    ])(
        "decodes the bytecode-defined packed purchases in $hash",
        async ({ hash, count, helper }) => {
            const tx = await readWyvernTransaction(import.meta.url, hash);
            const fills = decodeWyvernFills(tx, collections);
            expect(fills).toHaveLength(count);
            for (const fill of fills) {
                expect(fill.taker).toBe(helper);
                expect(fill.currency).toBe(zeroAddress);
                expect(fill.execution.items[0]!.recipient).toBe(
                    tx.transaction.from,
                );
                expect(
                    summarizeFillPayment(fill.execution.items).nftQuantity,
                ).toBe("1");
            }
            tx.transaction.input = tx.transaction.input.slice(0, -2) as Hex;
            expect(decodeWyvernFills(tx, collections)).toEqual([]);
        },
    );

    it("does not depend on tracked transfer events for complete bundle context", async () => {
        const tx = await readWyvernTransaction(
            import.meta.url,
            WYVERN_FIXTURE.Bundle,
        );
        tx.events = [];
        expect(decodeWyvernFills(tx, collections)).toHaveLength(2);
    });

    it.each([
        "unknown-emitter",
        "missing-calldata",
        "missing-bundle-transfer",
        "wrong-maker",
    ])("rejects %s instead of grafting a price", async (caseName) => {
        const tx = await readWyvernTransaction(
            import.meta.url,
            WYVERN_FIXTURE.Bundle,
        );
        const executionLog = tx.receiptLogs.find(
            (log) => log.logIndex === 714,
        )!;
        if (caseName === "unknown-emitter") executionLog.address = UNTRACKED;
        if (caseName === "missing-calldata") tx.transaction.input = "0x";
        if (caseName === "missing-bundle-transfer")
            tx.receiptLogs = tx.receiptLogs.filter(
                (log) =>
                    log.address.toLowerCase() !== WYVERN_FIXTURE_CONTRACT ||
                    log.logIndex === 712,
            );
        if (caseName === "wrong-maker")
            executionLog.topics[1] = ("0x" +
                "00".repeat(12) +
                UNTRACKED.slice(2)) as Hex;
        expect(decodeWyvernFills(tx, collections)).toEqual([]);
    });

    it("includes untracked ERC1155 quantity and conserves exact whole-wei payment", async () => {
        const tx = await mixedBundle();
        const fills = decodeWyvernFills(tx, collections);
        expect(fills).toHaveLength(1);
        const execution = fills[0]!.execution;
        expect(execution.items).toHaveLength(3);
        const prepared = prepareFillExecution(execution);
        expect(prepared.payment.nftQuantity).toBe("3");
        const first = allocateFillPayment(
            prepared.payment.totalPrice!,
            "3",
            "1",
            "0",
        );
        const second = allocateFillPayment(
            prepared.payment.totalPrice!,
            "3",
            "2",
            "1",
        );
        expect(first.unitPrice.denominator).toBe("3");
        expect(
            BigInt(first.attributedPrice) + BigInt(second.attributedPrice),
        ).toBe(380000000000000000n);
        expect(execution.items[1]).toMatchObject({
            contract: UNTRACKED,
            itemType: FILL_ITEM_TYPE.Erc1155,
            amount: "2",
        });
    });

    it("rejects an atomicizer bundle with an uninterpreted leaf", async () => {
        const tx = await mixedBundle(true);
        expect(decodeWyvernFills(tx, collections)).toEqual([]);
    });

    it("resolves token IDs and transfer endpoints using sequential replacement", async () => {
        const tx = await readWyvernTransaction(
            import.meta.url,
            WYVERN_FIXTURE.OldAsk,
        );
        const { args } = decodeFunctionData({
            abi: WYVERN_EXCHANGE_ABI,
            data: tx.transaction.input,
        });
        const buy = encodeFunctionData({
            abi: ERC721_TRANSFER_ABI,
            functionName: NFT_TRANSFER_FUNCTION_NAME.TransferFrom,
            args: [zeroAddress, args[0][1], 0n],
        });
        const sell = encodeFunctionData({
            abi: ERC721_TRANSFER_ABI,
            functionName: NFT_TRANSFER_FUNCTION_NAME.TransferFrom,
            args: [args[0][8], zeroAddress, 8764n],
        });
        const buyMask = ("0x" +
            "00".repeat(4) +
            "ff".repeat(32) +
            "00".repeat(32) +
            "ff".repeat(32)) as Hex;
        const sellMask = ("0x" +
            "00".repeat(36) +
            "ff".repeat(32) +
            "00".repeat(32)) as Hex;
        tx.transaction.input = encodeFunctionData({
            abi: WYVERN_EXCHANGE_ABI,
            functionName: WYVERN_FUNCTION_NAME.AtomicMatch,
            args: [
                args[0],
                args[1],
                args[2],
                buy,
                sell,
                buyMask,
                sellMask,
                args[7],
                args[8],
                args[9],
                args[10],
            ],
        });
        expect(decodeWyvernFills(tx, collections)).toMatchObject([
            { tokenId: "8764" },
        ]);
        tx.transaction.input = encodeFunctionData({
            abi: WYVERN_EXCHANGE_ABI,
            functionName: WYVERN_FUNCTION_NAME.AtomicMatch,
            args: [
                args[0],
                args[1],
                args[2],
                buy,
                sell,
                "0x00",
                sellMask,
                args[7],
                args[8],
                args[9],
                args[10],
            ],
        });
        expect(decodeWyvernFills(tx, collections)).toEqual([]);
    });

    it("skips an attempted Gem call whose NFT did not transfer", async () => {
        const tx = await readWyvernTransaction(
            import.meta.url,
            WYVERN_FIXTURE.OldAsk,
        );
        const { args } = decodeFunctionData({
            abi: WYVERN_EXCHANGE_ABI,
            data: tx.transaction.input,
        });
        const data = encodeFunctionData({
            abi: ERC721_TRANSFER_ABI,
            functionName: NFT_TRANSFER_FUNCTION_NAME.TransferFrom,
            args: [args[0][8], args[0][1], 8765n],
        });
        const failed = encodeFunctionData({
            abi: WYVERN_EXCHANGE_ABI,
            functionName: WYVERN_FUNCTION_NAME.AtomicMatch,
            args: [
                args[0],
                args[1],
                args[2],
                data,
                data,
                "0x",
                "0x",
                args[7],
                args[8],
                args[9],
                args[10],
            ],
        });
        tx.transaction.to = WYVERN_ROUTER_ADDRESS.Gem;
        tx.transaction.input = encodeFunctionData({
            abi: WYVERN_ROUTER_ABI,
            functionName: WYVERN_ROUTER_FUNCTION_NAME.BatchBuyFromOpenSea,
            args: [
                [
                    { value: 1n, tradeData: failed },
                    { value: 1n, tradeData: tx.transaction.input },
                ],
            ],
        });
        expect(decodeWyvernFills(tx, collections)).toMatchObject([
            {
                tokenId: "8764",
                execution: { protocolAddress: WYVERN_EXCHANGE_ADDRESS.V22 },
            },
        ]);
        expect(decodeWyvernFills(tx, collections)).toHaveLength(1);
    });

    it("withholds price when an opaque attempted call could share the execution identity", async () => {
        const tx = await readWyvernTransaction(
            import.meta.url,
            WYVERN_FIXTURE.OldAsk,
        );
        const { args } = decodeFunctionData({
            abi: WYVERN_EXCHANGE_ABI,
            data: tx.transaction.input,
        });
        const addresses = [...args[0]];
        addresses[4] = addresses[11] = UNTRACKED;
        const opaque = encodeFunctionData({
            abi: WYVERN_EXCHANGE_ABI,
            functionName: WYVERN_FUNCTION_NAME.AtomicMatch,
            args: [
                addresses as unknown as (typeof args)[0],
                args[1],
                args[2],
                "0x12345678",
                "0x12345678",
                "0x",
                "0x",
                args[7],
                args[8],
                args[9],
                args[10],
            ],
        });
        tx.transaction.to = WYVERN_ROUTER_ADDRESS.Gem;
        tx.transaction.input = encodeFunctionData({
            abi: WYVERN_ROUTER_ABI,
            functionName: WYVERN_ROUTER_FUNCTION_NAME.BatchBuyFromOpenSea,
            args: [
                [
                    { value: 1n, tradeData: opaque },
                    { value: 1n, tradeData: tx.transaction.input },
                ],
            ],
        });
        expect(decodeWyvernFills(tx, collections)).toEqual([]);
    });
});

async function mixedBundle(unknownLeaf = false): Promise<EnhancedTransaction> {
    const tx = await readWyvernTransaction(
        import.meta.url,
        WYVERN_FIXTURE.OldAsk,
    );
    const decoded = decodeFunctionData({
        abi: WYVERN_EXCHANGE_ABI,
        data: tx.transaction.input,
    });
    const args = decoded.args;
    const addresses = [...args[0]];
    const seller = addresses[8],
        buyer = addresses[1];
    const first = encodeFunctionData({
        abi: ERC721_TRANSFER_ABI,
        functionName: NFT_TRANSFER_FUNCTION_NAME.TransferFrom,
        args: [seller, buyer, 8764n],
    });
    const second = unknownLeaf
        ? "0x12345678"
        : encodeFunctionData({
              abi: ERC1155_TRANSFER_ABI,
              functionName: NFT_TRANSFER_FUNCTION_NAME.SafeTransferFrom,
              args: [seller, buyer, 7n, 2n, "0x"],
          });
    const payload = encodeFunctionData({
        abi: WYVERN_ATOMICIZER_ABI,
        functionName: WYVERN_NFT_FUNCTION_NAME.Atomicize,
        args: [
            [WYVERN_FIXTURE_CONTRACT, UNTRACKED],
            [0n, 0n],
            [BigInt((first.length - 2) / 2), BigInt((second.length - 2) / 2)],
            (first + second.slice(2)) as Hex,
        ],
    });
    addresses[4] = addresses[11] = WYVERN_NFT_TARGET_ADDRESS.Atomicizer;
    const flags = [...args[2]];
    flags[3] = flags[7] = WYVERN_CALL_TYPE.DelegateCall;
    tx.transaction.input = encodeFunctionData({
        abi: WYVERN_EXCHANGE_ABI,
        functionName: WYVERN_FUNCTION_NAME.AtomicMatch,
        args: [
            addresses as unknown as (typeof args)[0],
            args[1],
            flags as unknown as (typeof args)[2],
            payload,
            payload,
            "0x",
            "0x",
            args[7],
            args[8],
            args[9],
            args[10],
        ],
    });
    const base = tx.receiptLogs.find(
        (log) => log.address.toLowerCase() === WYVERN_FIXTURE_CONTRACT,
    )!;
    const erc721Topics = encodeEventTopics({
        abi: ERC721_ABI,
        eventName: ERC721_EVENT_NAME.Transfer,
        args: { from: seller, to: buyer, tokenId: 8764n },
    });
    const erc1155Topics = encodeEventTopics({
        abi: ERC1155_ABI,
        eventName: ERC1155_EVENT_NAME.TransferSingle,
        args: { operator: seller, from: seller, to: buyer },
    });
    tx.receiptLogs = [
        { ...base, logIndex: 10, data: "0x", topics: erc721Topics },
        {
            ...base,
            address: UNTRACKED,
            logIndex: 11,
            topics: erc1155Topics,
            data: encodeAbiParameters(
                [{ type: "uint256" }, { type: "uint256" }],
                [7n, 2n],
            ),
        },
        tx.receiptLogs.find((log) => log.logIndex === 245)!,
    ];
    return tx;
}
