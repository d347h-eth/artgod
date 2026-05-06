import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import { decodeSeaportFills } from "../src/application/fills/seaport.js";
import { readTxDump, toEnhancedTransaction } from "./helpers/tx-dumps.js";

const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

const CASES = [
    {
        name: "seaport take bid (fulfillAdvancedOrder)",
        dumpFile:
            "0xff81723998672fc56590b551ce13ac409cb3f365219e2aef20fcf194652b7d00.json",
        expected: {
            orderSide: "buy",
            maker: "0x8790aa2c89aece345bd8fe757bf8a675ea31af3c",
            taker: "0x193dc59c444398276b0864423f5056d87b7dcaf8",
            contract: "0x4e1f41613c9084fdb9e34e11fae9412427480e56",
            tokenId: "8011",
            priceTotal: "0.23",
            currency: WETH_ADDRESS,
        },
    },
    {
        name: "seaport take ask (fulfillBasicOrder_efficient_6GL6yc)",
        dumpFile:
            "0x30e4c9eabe1a74cb71ea2d9f4405318d277f0d0e5590f31d450704c5c98803cd.json",
        expected: {
            orderSide: "sell",
            maker: "0x3f51e7af7cf3e4be9af7b8f58324d0b085f4e4d9",
            taker: "0xd57721b29f2a17ab6a0635210ce05dbbecf5cbf4",
            contract: "0x4e1f41613c9084fdb9e34e11fae9412427480e56",
            tokenId: "7058",
            priceTotal: "0.25",
            currency: zeroAddress,
        },
    },
];

describe("seaport fill decoding (no traces)", () => {
    it.each(CASES)("$name", async ({ dumpFile, expected }) => {
        const dump = await readTxDump(import.meta.url, "tx", dumpFile);
        const tx = toEnhancedTransaction(dump);
        const collections = new Set([expected.contract]);

        const fills = decodeSeaportFills(tx, collections);
        expect(fills).toHaveLength(1);
        const fill = fills[0]!;

        expect(fill.orderSide).toBe(expected.orderSide);
        expect(fill.maker).toBe(expected.maker);
        expect(fill.taker).toBe(expected.taker);
        expect(fill.contract).toBe(expected.contract);
        expect(fill.tokenId).toBe(expected.tokenId);
        expect(fill.currency).toBe(expected.currency);
        expect(fill.price).toBe(parseEther(expected.priceTotal).toString());
    });
});

function parseEther(value: string): bigint {
    const [whole, fraction = ""] = value.split(".");
    const normalized = `${fraction}000000000000000000`.slice(0, 18);
    const wholePart = whole === "" ? 0n : BigInt(whole);
    const fractionPart = normalized === "" ? 0n : BigInt(normalized);
    return wholePart * 10n ** 18n + fractionPart;
}
