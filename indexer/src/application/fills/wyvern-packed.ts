import { zeroAddress, zeroHash } from "viem";
import { FILL_ITEM_TYPE } from "@artgod/shared/market-data/fills";
import { ORDER_SIDE } from "@artgod/shared/market-data/orders";
import type { EnhancedTransaction } from "../../domain/onchain.js";
import { WYVERN_EXCHANGE_ADDRESS } from "./wyvern-abi.js";
import type { WyvernMatchCall } from "./wyvern-calls.js";

export const WYVERN_PACKED_HELPER_ADDRESS = {
    V22: "0x00000000efaf2854f5b7975efe87edbfacd80b12",
    V23: "0x0000000035634b55f3d99b071b5a354f48e10bef",
} as const;

// These two small deployed bytecode programs construct fixed native-ETH,
// sell-side, single-ERC721 atomicMatch_ calls. Their payment-token words are
// zero-initialized and never copied from input; each transfer's recipient is
// CALLER. This is a decoded wire format, not an ETH inference from missing logs.
// The bytecode evidence and field mappings are retained with the fixtures.
const PACKED_FORMAT = {
    V22: { bytes: 199, sellerOffset: 22, identifierOffset: 103 },
    V23: {
        headerBytes: 22,
        tradeBytes: 168,
        sellerOffset: 26,
        identifierOffset: 111,
    },
} as const;

export function decodePackedWyvernCalls(
    transaction: EnhancedTransaction["transaction"],
): WyvernMatchCall[] {
    const helper = transaction.to?.toLowerCase();
    const data = transaction.input;
    if (!helper || !/^0x(?:[0-9a-f]{2})*$/i.test(data)) return [];
    const size = (data.length - 2) / 2;
    let protocolAddress: string;
    let count: number;
    let stride: number;
    let sellerOffset: number;
    let identifierOffset: number;
    if (helper === WYVERN_PACKED_HELPER_ADDRESS.V22) {
        if (size !== PACKED_FORMAT.V22.bytes) return [];
        protocolAddress = WYVERN_EXCHANGE_ADDRESS.V22;
        count = 1;
        stride = 0;
        ({ sellerOffset, identifierOffset } = PACKED_FORMAT.V22);
    } else if (helper === WYVERN_PACKED_HELPER_ADDRESS.V23) {
        const payloadBytes = size - PACKED_FORMAT.V23.headerBytes;
        if (
            payloadBytes <= 0 ||
            payloadBytes % PACKED_FORMAT.V23.tradeBytes !== 0
        )
            return [];
        protocolAddress = WYVERN_EXCHANGE_ADDRESS.V23;
        count = payloadBytes / PACKED_FORMAT.V23.tradeBytes;
        stride = PACKED_FORMAT.V23.tradeBytes;
        ({ sellerOffset, identifierOffset } = PACKED_FORMAT.V23);
    } else {
        return [];
    }
    const bytes = (offset: number, length: number) =>
        "0x" +
        data.slice(2 + offset * 2, 2 + (offset + length) * 2).toLowerCase();
    const contract = bytes(0, 20);
    const recipient = transaction.from.toLowerCase();
    if (contract === zeroAddress || recipient === zeroAddress) return [];
    const calls: WyvernMatchCall[] = [];
    for (let i = 0; i < count; i++) {
        const seller = bytes(sellerOffset + stride * i, 20);
        if (seller === zeroAddress) continue;
        calls.push({
            protocolAddress,
            maker: seller,
            taker: helper,
            seller,
            currency: zeroAddress,
            orderSide: ORDER_SIDE.Sell,
            metadata: zeroHash,
            nfts: [
                {
                    contract,
                    from: seller,
                    to: recipient,
                    identifier: BigInt(
                        bytes(identifierOffset + stride * i, 32),
                    ).toString(),
                    amount: "1",
                    itemType: FILL_ITEM_TYPE.Erc721,
                },
            ],
        });
    }
    return calls;
}
