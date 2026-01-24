import { decodeFunctionData, zeroAddress } from "viem";
import type {
    EnhancedEvent,
    EnhancedTransaction,
    FillEvent,
} from "../../domain/onchain.js";
import type { Hex } from "../../ports/rpc.js";
import {
    findTrackedNftItem,
    hasTrackedNft,
    isCurrencyItem,
    normalizeCurrency,
    sumAmounts,
    type SeaportItem,
} from "./seaport-shared.js";

type OrderSide = "sell" | "buy";

type OfferItem = SeaportItem & { endAmount: bigint };

type ConsiderationItem = OfferItem & { recipient: Hex };

type BasicOrderParameters = {
    considerationToken: Hex;
    considerationIdentifier: bigint;
    considerationAmount: bigint;
    offerer: Hex;
    zone: Hex;
    offerToken: Hex;
    offerIdentifier: bigint;
    offerAmount: bigint;
    basicOrderType: number;
    startTime: bigint;
    endTime: bigint;
    zoneHash: Hex;
    salt: bigint;
    offererConduitKey: Hex;
    fulfillerConduitKey: Hex;
    totalOriginalAdditionalRecipients: bigint;
    additionalRecipients: { amount: bigint; recipient: Hex }[];
    signature: Hex;
};

type AdvancedOrder = {
    parameters: {
        offerer: Hex;
        zone: Hex;
        offer: OfferItem[];
        consideration: ConsiderationItem[];
        orderType: number;
        startTime: bigint;
        endTime: bigint;
        zoneHash: Hex;
        salt: bigint;
        conduitKey: Hex;
        totalOriginalConsiderationItems: bigint;
    };
    numerator: bigint;
    denominator: bigint;
    signature: Hex;
    extraData: Hex;
};

const SEAPORT_ABI = [
    {
        type: "function",
        name: "fulfillBasicOrder",
        inputs: [
            {
                name: "",
                type: "tuple",
                components: [
                    { name: "considerationToken", type: "address" },
                    { name: "considerationIdentifier", type: "uint256" },
                    { name: "considerationAmount", type: "uint256" },
                    { name: "offerer", type: "address" },
                    { name: "zone", type: "address" },
                    { name: "offerToken", type: "address" },
                    { name: "offerIdentifier", type: "uint256" },
                    { name: "offerAmount", type: "uint256" },
                    { name: "basicOrderType", type: "uint8" },
                    { name: "startTime", type: "uint256" },
                    { name: "endTime", type: "uint256" },
                    { name: "zoneHash", type: "bytes32" },
                    { name: "salt", type: "uint256" },
                    { name: "offererConduitKey", type: "bytes32" },
                    { name: "fulfillerConduitKey", type: "bytes32" },
                    { name: "totalOriginalAdditionalRecipients", type: "uint256" },
                    {
                        name: "additionalRecipients",
                        type: "tuple[]",
                        components: [
                            { name: "amount", type: "uint256" },
                            { name: "recipient", type: "address" },
                        ],
                    },
                    { name: "signature", type: "bytes" },
                ],
            },
        ],
        outputs: [{ name: "fulfilled", type: "bool" }],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "fulfillBasicOrder_efficient_6GL6yc",
        inputs: [
            {
                name: "",
                type: "tuple",
                components: [
                    { name: "considerationToken", type: "address" },
                    { name: "considerationIdentifier", type: "uint256" },
                    { name: "considerationAmount", type: "uint256" },
                    { name: "offerer", type: "address" },
                    { name: "zone", type: "address" },
                    { name: "offerToken", type: "address" },
                    { name: "offerIdentifier", type: "uint256" },
                    { name: "offerAmount", type: "uint256" },
                    { name: "basicOrderType", type: "uint8" },
                    { name: "startTime", type: "uint256" },
                    { name: "endTime", type: "uint256" },
                    { name: "zoneHash", type: "bytes32" },
                    { name: "salt", type: "uint256" },
                    { name: "offererConduitKey", type: "bytes32" },
                    { name: "fulfillerConduitKey", type: "bytes32" },
                    { name: "totalOriginalAdditionalRecipients", type: "uint256" },
                    {
                        name: "additionalRecipients",
                        type: "tuple[]",
                        components: [
                            { name: "amount", type: "uint256" },
                            { name: "recipient", type: "address" },
                        ],
                    },
                    { name: "signature", type: "bytes" },
                ],
            },
        ],
        outputs: [{ name: "fulfilled", type: "bool" }],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "fulfillAdvancedOrder",
        inputs: [
            {
                name: "",
                type: "tuple",
                components: [
                    {
                        name: "parameters",
                        type: "tuple",
                        components: [
                            { name: "offerer", type: "address" },
                            { name: "zone", type: "address" },
                            {
                                name: "offer",
                                type: "tuple[]",
                                components: [
                                    { name: "itemType", type: "uint8" },
                                    { name: "token", type: "address" },
                                    {
                                        name: "identifierOrCriteria",
                                        type: "uint256",
                                    },
                                    { name: "startAmount", type: "uint256" },
                                    { name: "endAmount", type: "uint256" },
                                ],
                            },
                            {
                                name: "consideration",
                                type: "tuple[]",
                                components: [
                                    { name: "itemType", type: "uint8" },
                                    { name: "token", type: "address" },
                                    {
                                        name: "identifierOrCriteria",
                                        type: "uint256",
                                    },
                                    { name: "startAmount", type: "uint256" },
                                    { name: "endAmount", type: "uint256" },
                                    { name: "recipient", type: "address" },
                                ],
                            },
                            { name: "orderType", type: "uint8" },
                            { name: "startTime", type: "uint256" },
                            { name: "endTime", type: "uint256" },
                            { name: "zoneHash", type: "bytes32" },
                            { name: "salt", type: "uint256" },
                            { name: "conduitKey", type: "bytes32" },
                            {
                                name: "totalOriginalConsiderationItems",
                                type: "uint256",
                            },
                        ],
                    },
                    { name: "numerator", type: "uint120" },
                    { name: "denominator", type: "uint120" },
                    { name: "signature", type: "bytes" },
                    { name: "extraData", type: "bytes" },
                ],
            },
            {
                name: "",
                type: "tuple[]",
                components: [
                    { name: "orderIndex", type: "uint256" },
                    { name: "side", type: "uint8" },
                    { name: "index", type: "uint256" },
                    { name: "identifier", type: "uint256" },
                    { name: "criteriaProof", type: "bytes32[]" },
                ],
            },
            { name: "fulfillerConduitKey", type: "bytes32" },
            { name: "recipient", type: "address" },
        ],
        outputs: [{ name: "fulfilled", type: "bool" }],
        stateMutability: "payable",
    },
] as const;

export const SEAPORT_EXCHANGE_ADDRESSES = new Set(
    [
        "0x00000000006c3852cbef3e08e8df289169ede581",
        "0x00000000000001ad428e4906ae43d8f9852d0dd6",
        "0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
        "0x0000000000000068f116a894984e2db1123eb395",
    ].map((address) => address.toLowerCase()),
);

// Decode Seaport fills using calldata only (no traces or Seaport logs).
export function decodeSeaportFill(
    tx: EnhancedTransaction,
    collections: Set<string>,
): FillEvent | null {
    const to = tx.transaction.to?.toLowerCase();
    if (!to || !SEAPORT_EXCHANGE_ADDRESSES.has(to)) return null;

    let decoded: ReturnType<typeof decodeFunctionData> | null = null;
    try {
        decoded = decodeFunctionData({
            abi: SEAPORT_ABI,
            data: tx.transaction.input,
        });
    } catch {
        return null;
    }

    if (!decoded) return null;

    if (
        decoded.functionName === "fulfillBasicOrder" ||
        decoded.functionName === "fulfillBasicOrder_efficient_6GL6yc"
    ) {
        const order = decoded.args[0] as BasicOrderParameters | undefined;
        if (!order) return null;
        return decodeBasicOrderFill(tx, order, collections);
    }

    if (decoded.functionName === "fulfillAdvancedOrder") {
        const advanced = decoded.args[0] as AdvancedOrder | undefined;
        if (!advanced) return null;
        return decodeAdvancedOrderFill(tx, advanced, collections);
    }

    return null;
}

function decodeBasicOrderFill(
    tx: EnhancedTransaction,
    order: BasicOrderParameters,
    collections: Set<string>,
): FillEvent | null {
    const offerToken = order.offerToken.toLowerCase();
    const considerationToken = order.considerationToken.toLowerCase();
    const offerIsTracked = collections.has(offerToken);
    const considerationIsTracked = collections.has(considerationToken);
    if (offerIsTracked === considerationIsTracked) return null;

    const orderSide: OrderSide = offerIsTracked ? "sell" : "buy";
    const maker = order.offerer.toLowerCase();
    const taker = tx.transaction.from.toLowerCase();
    const logIndex = firstTransferLogIndex(tx.events);

    const nft = offerIsTracked
        ? {
              contract: offerToken,
              tokenId: order.offerIdentifier.toString(),
              amount: order.offerAmount.toString(),
          }
        : {
              contract: considerationToken,
              tokenId: order.considerationIdentifier.toString(),
              amount: order.considerationAmount.toString(),
          };

    const price =
        orderSide === "sell"
            ? sumAmounts([
                  order.considerationAmount,
                  ...order.additionalRecipients.map((item) => item.amount),
              ])
            : order.offerAmount;

    const currency =
        orderSide === "sell" ? order.considerationToken : order.offerToken;

    return {
        kind: "seaport",
        orderSide,
        maker,
        taker,
        contract: nft.contract,
        tokenId: nft.tokenId,
        amount: nft.amount,
        price: price.toString(),
        currency: normalizeCurrency(currency),
        blockNumber: tx.blockNumber,
        blockHash: tx.blockHash,
        txHash: tx.txHash,
        logIndex,
    };
}

function decodeAdvancedOrderFill(
    tx: EnhancedTransaction,
    order: AdvancedOrder,
    collections: Set<string>,
): FillEvent | null {
    const maker = order.parameters.offerer.toLowerCase();
    const taker = tx.transaction.from.toLowerCase();
    const logIndex = firstTransferLogIndex(tx.events);

    const offer = order.parameters.offer;
    const consideration = order.parameters.consideration;

    const offerHasTrackedNft = hasTrackedNft(offer, collections);
    const considerationHasTrackedNft = hasTrackedNft(
        consideration,
        collections,
    );

    const orderSide: OrderSide | null = offerHasTrackedNft
        ? "sell"
        : considerationHasTrackedNft
          ? "buy"
          : null;

    if (!orderSide) {
        return null;
    }

    const nft =
        orderSide === "sell"
            ? findTrackedNftItem(offer, collections) ??
              resolveNftFromTransfers(tx.events, collections)
            : findTrackedNftItem(consideration, collections) ??
              resolveNftFromTransfers(tx.events, collections);
    if (!nft) return null;

    const currencyItems =
        orderSide === "sell"
            ? consideration.filter((item) => isCurrencyItem(item.itemType))
            : offer.filter((item) => isCurrencyItem(item.itemType));
    if (currencyItems.length === 0) return null;

    const price = sumAmounts(currencyItems.map((item) => item.startAmount));
    const currency = normalizeCurrency(currencyItems[0]?.token ?? zeroAddress);

    return {
        kind: "seaport",
        orderSide,
        maker,
        taker,
        contract: nft.contract,
        tokenId: nft.tokenId,
        amount: nft.amount,
        price: price.toString(),
        currency,
        blockNumber: tx.blockNumber,
        blockHash: tx.blockHash,
        txHash: tx.txHash,
        logIndex,
    };
}

function resolveNftFromTransfers(
    events: EnhancedEvent[],
    collections: Set<string>,
): { contract: string; tokenId: string; amount: string } | null {
    for (const event of events) {
        const contract = event.base.contract.toLowerCase();
        if (!collections.has(contract)) continue;
        return {
            contract,
            tokenId: event.decoded.tokenId,
            amount: event.decoded.amount,
        };
    }
    return null;
}

function firstTransferLogIndex(events: EnhancedEvent[]): number {
    return events[0]?.base.logIndex ?? 0;
}
