import { zeroAddress } from "viem";
import { ORDER_SIDE } from "@artgod/shared/market-data/orders";
import { WYVERN_EXCHANGE_ADDRESS } from "../../src/application/fills/wyvern-abi.js";
import { readTxDump, toEnhancedTransaction } from "./tx-dumps.js";

export const WYVERN_FIXTURE_CONTRACT =
    "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
export const WYVERN_FIXTURE_WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export const WYVERN_FIXTURE = {
    OldAsk: "0x0215e7dfb508756477627aafebea1d3af2f06205170f0348d3ca2293fa2db397",
    OldBid: "0x12da43c49d22810555af9ef4b53c0002227cefed1348975e4aa9932c5facb5e1",
    CriteriaAsk:
        "0x02803bf82b7e578f1ff56e903bc96c8bb8483459dcebeb097aaaaaaa73a45902",
    CriteriaBid:
        "0x236ddd1b7499ffa3616545c6cb9374c32c155db6732cafc87153668a5633196b",
    Bundle: "0x1fc9daa95f33a98716fa5d9264dd41b29a9fb62948657e2fbc5d5595ca41c3eb",
    Gem: "0x3a032f976a6b34619a43e5a751ce3b7a44477693a16b3ac5154f47e5b891c9c7",
    Genie: "0x0902cc77d1013d1b98ac24c8037d143e5d98acf56df3eb55a9d19edbc228c476",
    Argent: "0x79747f10bfa43f09e0dd548156b189b497b285e6ee42a4a481aeaff4bc95c36d",
    PackedV22:
        "0x0a5a3cbc82e0b2e248719ffdb2fd7a5581b9535dab098c2d0438ed194066f330",
    PackedV23:
        "0x7450212e4775f136ed3f96be49b1f7b0d54747f6a75921368f2f850010264cd8",
} as const;

export const WYVERN_DIRECT_SALES = [
    {
        hash: WYVERN_FIXTURE.OldAsk,
        tokenId: "8764",
        price: "380000000000000000",
        currency: zeroAddress,
        orderSide: ORDER_SIDE.Sell,
        protocol: WYVERN_EXCHANGE_ADDRESS.V22,
        logIndex: 245,
    },
    {
        hash: WYVERN_FIXTURE.OldBid,
        tokenId: "2118",
        price: "330000000000000000",
        currency: WYVERN_FIXTURE_WETH,
        orderSide: ORDER_SIDE.Buy,
        protocol: WYVERN_EXCHANGE_ADDRESS.V22,
        logIndex: 54,
    },
    {
        hash: WYVERN_FIXTURE.CriteriaAsk,
        tokenId: "9797",
        price: "620000000000000000",
        currency: zeroAddress,
        orderSide: ORDER_SIDE.Sell,
        protocol: WYVERN_EXCHANGE_ADDRESS.V23,
        logIndex: 434,
    },
    {
        hash: WYVERN_FIXTURE.CriteriaBid,
        tokenId: "8705",
        price: "600000000000000000",
        currency: WYVERN_FIXTURE_WETH,
        orderSide: ORDER_SIDE.Buy,
        protocol: WYVERN_EXCHANGE_ADDRESS.V23,
        logIndex: 312,
    },
] as const;

export async function readWyvernTransaction(
    importMetaUrl: string,
    hash: string,
) {
    return toEnhancedTransaction(
        await readTxDump(importMetaUrl, "fill-txs/wyvern", hash + ".json"),
    );
}
