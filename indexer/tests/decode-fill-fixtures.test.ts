import { describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import {
    BLUR_BETH_ADDRESS,
    decodeBlurFills,
} from "../src/application/fills/blur.js";
import { decodeSeaportFills } from "../src/application/fills/seaport.js";
import type { DecodedFillEvent } from "../src/application/fills/types.js";
import { readTxDump, toEnhancedTransaction } from "./helpers/tx-dumps.js";

const TERRAFORMS_CONTRACT = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const WETH_ADDRESS = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

type ExpectedFill = {
    tokenId: string;
    orderSide: "sell" | "buy";
    price: string;
    currency: string;
};

const SEAPORT_CASES: Array<{
    name: string;
    dumpFile: string;
    expected: ExpectedFill[];
}> = [
    {
        name: "matchAdvancedOrders take-bid keeps one gross bid fill",
        dumpFile:
            "0xe6fcee3b20d041194bdbf9b4a53ab9ad4651241b293c3bd14c5ed6255d3a0d01.json",
        expected: [
            {
                tokenId: "762",
                orderSide: "buy",
                price: "0.228",
                currency: WETH_ADDRESS,
            },
        ],
    },
    {
        name: "fulfillAvailableAdvancedOrders take-bid emits five fills",
        dumpFile:
            "0x10639cf281b96d54a1bb4fe9b34647e77cac1e05468642e08978cbf6f06d198d.json",
        expected: [
            {
                tokenId: "3215",
                orderSide: "buy",
                price: "0.224",
                currency: WETH_ADDRESS,
            },
            {
                tokenId: "7235",
                orderSide: "buy",
                price: "0.223",
                currency: WETH_ADDRESS,
            },
            {
                tokenId: "135",
                orderSide: "buy",
                price: "0.235",
                currency: WETH_ADDRESS,
            },
            {
                tokenId: "8314",
                orderSide: "buy",
                price: "0.251",
                currency: WETH_ADDRESS,
            },
            {
                tokenId: "1546",
                orderSide: "buy",
                price: "0.391",
                currency: WETH_ADDRESS,
            },
        ],
    },
    {
        name: "fulfillAvailableAdvancedOrders take-ask emits four fills",
        dumpFile:
            "0xe24f0e18fce6c1195bd8d0f51ca41c547f6570e4dd990263789a19e9b11d64cb.json",
        expected: [
            {
                tokenId: "9863",
                orderSide: "sell",
                price: "0.27899999",
                currency: zeroAddress,
            },
            {
                tokenId: "4972",
                orderSide: "sell",
                price: "0.287",
                currency: zeroAddress,
            },
            {
                tokenId: "3047",
                orderSide: "sell",
                price: "0.299",
                currency: zeroAddress,
            },
            {
                tokenId: "2896",
                orderSide: "sell",
                price: "0.299",
                currency: zeroAddress,
            },
        ],
    },
    {
        name: "RelayRouterV3 routed take-ask decodes from Seaport receipt log",
        dumpFile:
            "0x403a5089cb5ca2245949f7ca251bd067fbf2d7092215d295acba53e262e015d7.json",
        expected: [
            {
                tokenId: "1139",
                orderSide: "sell",
                price: "0.47",
                currency: zeroAddress,
            },
        ],
    },
    {
        name: "RelayApprovalProxyV3 routed WETH-funded take-ask keeps Seaport currency",
        dumpFile:
            "0x4b7a8b0ba714aa9e74ee181befd6e112a8d325c1758f2fb56e3eb083afda5c18.json",
        expected: [
            {
                tokenId: "2427",
                orderSide: "sell",
                price: "0.2299999",
                currency: zeroAddress,
            },
        ],
    },
    {
        name: "RelayApprovalProxyV3 routed batch emits three Seaport fills",
        dumpFile:
            "0xdfa4558783c3ada80050ec06ff0b872eded71d39c58bde4b4b1b64525e02fef1.json",
        expected: [
            {
                tokenId: "2445",
                orderSide: "sell",
                price: "0.5",
                currency: zeroAddress,
            },
            {
                tokenId: "7014",
                orderSide: "sell",
                price: "0.6",
                currency: zeroAddress,
            },
            {
                tokenId: "5035",
                orderSide: "sell",
                price: "0.8",
                currency: zeroAddress,
            },
        ],
    },
    {
        name: "Gondi buy wrapper keeps marketplace listing sale only",
        dumpFile:
            "0xbaf62d4821e341ec0d59ba39ad2fd83136c03c6cfba4937c43ccad0c62c1216c.json",
        expected: [
            {
                tokenId: "7254",
                orderSide: "sell",
                price: "0.256219",
                currency: zeroAddress,
            },
        ],
    },
    {
        name: "Gondi sell wrapper keeps marketplace bid sale only",
        dumpFile:
            "0xf197ae589a91e2e563c1fa3a30545ae383b9c95e281abce1b9aae59be18246ec.json",
        expected: [
            {
                tokenId: "7254",
                orderSide: "buy",
                price: "0.204",
                currency: WETH_ADDRESS,
            },
        ],
    },
];

const BLUR_CASES: Array<{
    name: string;
    dumpFile: string;
    expected: ExpectedFill[];
}> = [
    {
        name: "takeAskSingle emits native sell fill",
        dumpFile:
            "0xb2d2fc84955e498ea5079d95a4cba4726e3771369cb7bfa784de0b01e8e06050.json",
        expected: [
            {
                tokenId: "8113",
                orderSide: "sell",
                price: "0.3",
                currency: zeroAddress,
            },
        ],
    },
    {
        name: "takeBidSingle emits BETH buy fill",
        dumpFile:
            "0x2e99eb8492a1a6732bab9a8feaa58635c04710da0065ccca8b47efb2d90feebb.json",
        expected: [
            {
                tokenId: "4972",
                orderSide: "buy",
                price: "0.25",
                currency: BLUR_BETH_ADDRESS,
            },
        ],
    },
    {
        name: "takeBid emits three BETH buy fills",
        dumpFile:
            "0x9ed1dee993634827655217ad5d0b36047acb4ce67748a70efb5e3d02cf4f43cd.json",
        expected: [
            {
                tokenId: "5812",
                orderSide: "buy",
                price: "0.22",
                currency: BLUR_BETH_ADDRESS,
            },
            {
                tokenId: "4067",
                orderSide: "buy",
                price: "0.23",
                currency: BLUR_BETH_ADDRESS,
            },
            {
                tokenId: "5542",
                orderSide: "buy",
                price: "0.22",
                currency: BLUR_BETH_ADDRESS,
            },
        ],
    },
    {
        name: "takeAsk emits two native sell fills",
        dumpFile:
            "0x406e361a6cc71c62326f0fddb92bfc291459da516b4dc928a789a8b8c7a80416.json",
        expected: [
            {
                tokenId: "3215",
                orderSide: "sell",
                price: "0.2295703",
                currency: zeroAddress,
            },
            {
                tokenId: "7235",
                orderSide: "sell",
                price: "0.229599",
                currency: zeroAddress,
            },
        ],
    },
    {
        name: "takeAskSinglePool emits BETH sell fill",
        dumpFile:
            "0x0a1a86e26d16771806e1266e5b77eca7de1e4c73989ffa66452b5c60f9bf1994.json",
        expected: [
            {
                tokenId: "3140",
                orderSide: "sell",
                price: "0.278999",
                currency: BLUR_BETH_ADDRESS,
            },
        ],
    },
];

describe("fill decoding fixtures (no traces)", () => {
    it.each(SEAPORT_CASES)("decodes Seaport: $name", async (testCase) => {
        const fills = await decodeFixture(testCase.dumpFile, "seaport");
        expectFillSet(fills, testCase.expected);
    });

    it.each(BLUR_CASES)("decodes Blur V2: $name", async (testCase) => {
        const fills = await decodeFixture(testCase.dumpFile, "blur");
        expectFillSet(fills, testCase.expected);
    });
});

async function decodeFixture(
    dumpFile: string,
    kind: "seaport" | "blur",
): Promise<DecodedFillEvent[]> {
    const dump = await readTxDump(import.meta.url, "fill-txs", dumpFile);
    const tx = toEnhancedTransaction(dump);
    const collections = new Set([TERRAFORMS_CONTRACT]);
    return kind === "seaport"
        ? decodeSeaportFills(tx, collections)
        : decodeBlurFills(tx, collections);
}

function expectFillSet(fills: DecodedFillEvent[], expected: ExpectedFill[]) {
    expect(fills).toHaveLength(expected.length);
    const normalized = fills.map((fill) => ({
        tokenId: fill.tokenId,
        orderSide: fill.orderSide,
        price: fill.price,
        currency: fill.currency,
    }));
    expect(normalized).toEqual(
        expected.map((fill) => ({
            tokenId: fill.tokenId,
            orderSide: fill.orderSide,
            price: parseEther(fill.price).toString(),
            currency: fill.currency,
        })),
    );
}

function parseEther(value: string): bigint {
    const [whole, fraction = ""] = value.split(".");
    const normalized = `${fraction}000000000000000000`.slice(0, 18);
    const wholePart = whole === "" ? 0n : BigInt(whole);
    const fractionPart = normalized === "" ? 0n : BigInt(normalized);
    return wholePart * 10n ** 18n + fractionPart;
}
