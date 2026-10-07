import { decodeEventLog, zeroAddress } from "viem";
import {
    BLUR_BETH_ADDRESS,
    FILL_KIND,
    FILL_ITEM_SIDE,
    FILL_ITEM_TYPE,
    type FillExecution,
} from "@artgod/shared/market-data/fills";
import { ORDER_SIDE } from "@artgod/shared/market-data/orders";
export { BLUR_BETH_ADDRESS } from "@artgod/shared/market-data/fills";

import {
    COLLECTION_STANDARD,
    type CollectionStandard,
} from "../../domain/collections.js";
import type {
    EnhancedEvent,
    EnhancedTransaction,
} from "../../domain/onchain.js";
import type { Hex, RpcLog } from "../../ports/rpc.js";
import type { DecodedFillEvent, OrderSide } from "./types.js";

export const BLUR_EXCHANGE_V2_ADDRESSES = new Set([
    "0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5",
]);
// Wire enums and event names from Blur V2's Executor and Structs contracts.
export const BLUR_ORDER_TYPE = { Ask: 0, Bid: 1 } as const;
export const BLUR_ASSET_TYPE = { Erc721: 0, Erc1155: 1 } as const;
export const BLUR_EXECUTION_EVENT_NAME = {
    Packed: "Execution721Packed",
    MakerFeePacked: "Execution721MakerFeePacked",
    TakerFeePacked: "Execution721TakerFeePacked",
    Unpacked: "Execution",
} as const;

const packedInputs = [
    { indexed: false, name: "orderHash", type: "bytes32" },
    { indexed: false, name: "tokenIdListingIndexTrader", type: "uint256" },
    { indexed: false, name: "collectionPriceSide", type: "uint256" },
] as const;
const feeComponents = [
    { name: "recipient", type: "address" },
    { name: "rate", type: "uint16" },
] as const;

export const BLUR_EXECUTION_EVENT_ABI = [
    {
        type: "event",
        name: BLUR_EXECUTION_EVENT_NAME.Packed,
        inputs: packedInputs,
        anonymous: false,
    },
    {
        type: "event",
        name: BLUR_EXECUTION_EVENT_NAME.MakerFeePacked,
        inputs: [
            ...packedInputs,
            { indexed: false, name: "makerFeeRecipientRate", type: "uint256" },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: BLUR_EXECUTION_EVENT_NAME.TakerFeePacked,
        inputs: [
            ...packedInputs,
            { indexed: false, name: "takerFeeRecipientRate", type: "uint256" },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: BLUR_EXECUTION_EVENT_NAME.Unpacked,
        inputs: [
            {
                indexed: false,
                name: "transfer",
                type: "tuple",
                components: [
                    { name: "trader", type: "address" },
                    { name: "id", type: "uint256" },
                    { name: "amount", type: "uint256" },
                    { name: "collection", type: "address" },
                    { name: "assetType", type: "uint8" },
                ],
            },
            { indexed: false, name: "orderHash", type: "bytes32" },
            { indexed: false, name: "listingIndex", type: "uint256" },
            { indexed: false, name: "price", type: "uint256" },
            {
                indexed: false,
                name: "makerFee",
                type: "tuple",
                components: feeComponents,
            },
            {
                indexed: false,
                name: "fees",
                type: "tuple",
                components: [
                    {
                        name: "protocolFee",
                        type: "tuple",
                        components: feeComponents,
                    },
                    {
                        name: "takerFee",
                        type: "tuple",
                        components: feeComponents,
                    },
                ],
            },
            { indexed: false, name: "orderType", type: "uint8" },
        ],
        anonymous: false,
    },
] as const;

export const BLUR_EXCHANGE_V2_ABI = [
    {
        type: "function",
        name: "takeAskSingle",
        inputs: [
            {
                name: "inputs",
                type: "tuple",
                components: singleInputComponents(true),
            },
            { name: "oracleSignature", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "takeBidSingle",
        inputs: [
            {
                name: "inputs",
                type: "tuple",
                components: singleInputComponents(false),
            },
            { name: "oracleSignature", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "takeBid",
        inputs: [
            {
                name: "inputs",
                type: "tuple",
                components: batchInputComponents(false),
            },
            { name: "oracleSignature", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    {
        type: "function",
        name: "takeAsk",
        inputs: [
            {
                name: "inputs",
                type: "tuple",
                components: batchInputComponents(true),
            },
            { name: "oracleSignature", type: "bytes" },
        ],
        outputs: [],
        stateMutability: "payable",
    },
    {
        type: "function",
        name: "takeAskSinglePool",
        inputs: [
            {
                name: "inputs",
                type: "tuple",
                components: singleInputComponents(true),
            },
            { name: "oracleSignature", type: "bytes" },
            { name: "amountToWithdraw", type: "uint256" },
        ],
        outputs: [],
        stateMutability: "nonpayable",
    },
    ...BLUR_EXECUTION_EVENT_ABI,
] as const;

export { BLUR_EXECUTION_EVENT_ABI as BLUR_EXECUTION_ABI };

// Executor packs an address in 160 bits, listing index in 8 bits, and
// token ID / price in 88 bits. The order type occupies the top byte.
const ADDRESS_BITS = 160n;
const TOKEN_ID_SHIFT = 168n;
const ORDER_TYPE_SHIFT = 248n;
const ADDRESS_MASK = (1n << ADDRESS_BITS) - 1n;
const PACKED_PRICE_MASK = (1n << 88n) - 1n;

type BlurExecution = {
    orderHash: Hex;
    logIndex: number;
    maker: string;
    contract: string;
    tokenId: string;
    amount: string;
    price: string;
    orderSide: OrderSide;
    standard: CollectionStandard;
};

// Receipts identify successful executions even when a router calls Blur or a
// batch skips an input. Filter and match each execution before emitting its fill.
export function decodeBlurFills(
    tx: EnhancedTransaction,
    collections: Set<string>,
): DecodedFillEvent[] {
    const fills: DecodedFillEvent[] = [];
    const usedTransfers = new Set<EnhancedEvent>();
    for (const log of [...tx.receiptLogs].sort(
        (a, b) => a.logIndex - b.logIndex,
    )) {
        const execution = decodeExecution(log);
        if (!execution || !collections.has(execution.contract)) continue;
        const transfer = matchTransfer(tx.events, execution, usedTransfers);
        if (!transfer) continue;
        usedTransfers.add(transfer);
        const isAsk = execution.orderSide === ORDER_SIDE.Sell;
        const taker = isAsk
            ? transfer.decoded.to.toLowerCase()
            : transfer.decoded.from.toLowerCase();
        // Pool-funded asks withdraw native ETH; accepted bids settle in BETH.
        const currency = isAsk ? zeroAddress : BLUR_BETH_ADDRESS;
        const context: FillExecution = {
            protocolAddress: log.address.toLowerCase(),
            items: [
                {
                    index: 0,
                    side: isAsk
                        ? FILL_ITEM_SIDE.Offer
                        : FILL_ITEM_SIDE.Consideration,
                    itemType:
                        execution.standard === COLLECTION_STANDARD.Erc721
                            ? FILL_ITEM_TYPE.Erc721
                            : FILL_ITEM_TYPE.Erc1155,
                    contract: execution.contract,
                    identifier: execution.tokenId,
                    amount: execution.amount,
                    recipient: isAsk ? taker : execution.maker,
                },
                {
                    index: 1,
                    side: isAsk
                        ? FILL_ITEM_SIDE.Consideration
                        : FILL_ITEM_SIDE.Offer,
                    itemType: isAsk
                        ? FILL_ITEM_TYPE.Native
                        : FILL_ITEM_TYPE.Erc20,
                    contract: currency,
                    identifier: "0",
                    // Execution.price is gross for the actually executed quantity.
                    amount: execution.price,
                    recipient: isAsk ? execution.maker : taker,
                },
            ],
        };
        fills.push({
            kind: FILL_KIND.BlurV2,
            orderId: execution.orderHash,
            orderSide: execution.orderSide,
            maker: execution.maker,
            taker,
            contract: execution.contract,
            tokenId: execution.tokenId,
            amount: execution.amount,
            price: execution.price,
            currency,
            execution: context,
            executionItemIndex: 0,
            blockNumber: tx.blockNumber,
            blockHash: tx.blockHash,
            txHash: tx.txHash,
            logIndex: execution.logIndex,
        });
    }
    return fills;
}

function decodeExecution(log: RpcLog): BlurExecution | null {
    if (!BLUR_EXCHANGE_V2_ADDRESSES.has(log.address.toLowerCase())) return null;
    try {
        const decoded = decodeEventLog({
            abi: BLUR_EXECUTION_EVENT_ABI,
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
        });
        if (decoded.eventName === BLUR_EXECUTION_EVENT_NAME.Unpacked) {
            const { transfer, price, orderType, orderHash } = decoded.args;
            return toExecution(
                log,
                orderHash,
                transfer.trader,
                transfer.collection,
                transfer.id,
                transfer.amount,
                price,
                orderType,
                transfer.assetType,
            );
        }
        const { orderHash, tokenIdListingIndexTrader, collectionPriceSide } =
            decoded.args;
        return toExecution(
            log,
            orderHash,
            unpackAddress(tokenIdListingIndexTrader),
            unpackAddress(collectionPriceSide),
            tokenIdListingIndexTrader >> TOKEN_ID_SHIFT,
            1n,
            (collectionPriceSide >> ADDRESS_BITS) & PACKED_PRICE_MASK,
            Number(collectionPriceSide >> ORDER_TYPE_SHIFT),
            BLUR_ASSET_TYPE.Erc721,
        );
    } catch {
        return null;
    }
}

function toExecution(
    log: RpcLog,
    orderHash: Hex,
    maker: string,
    contract: string,
    tokenId: bigint,
    amount: bigint,
    price: bigint,
    orderType: number,
    assetType: number,
): BlurExecution | null {
    if (orderType !== BLUR_ORDER_TYPE.Ask && orderType !== BLUR_ORDER_TYPE.Bid)
        return null;
    if (
        assetType !== BLUR_ASSET_TYPE.Erc721 &&
        assetType !== BLUR_ASSET_TYPE.Erc1155
    )
        return null;
    const nftAmount = assetType === BLUR_ASSET_TYPE.Erc721 ? 1n : amount;
    if (nftAmount <= 0n) return null;
    return {
        orderHash,
        logIndex: log.logIndex,
        maker: maker.toLowerCase(),
        contract: contract.toLowerCase(),
        tokenId: tokenId.toString(),
        amount: nftAmount.toString(),
        price: price.toString(),
        orderSide:
            orderType === BLUR_ORDER_TYPE.Ask
                ? ORDER_SIDE.Sell
                : ORDER_SIDE.Buy,
        standard:
            assetType === BLUR_ASSET_TYPE.Erc721
                ? COLLECTION_STANDARD.Erc721
                : COLLECTION_STANDARD.Erc1155,
    };
}

function unpackAddress(value: bigint): Hex {
    return ("0x" +
        (value & ADDRESS_MASK).toString(16).padStart(40, "0")) as Hex;
}

function matchTransfer(
    events: readonly EnhancedEvent[],
    execution: BlurExecution,
    used: Set<EnhancedEvent>,
): EnhancedEvent | null {
    let closest: EnhancedEvent | null = null;
    for (const event of events) {
        if (
            used.has(event) ||
            event.base.logIndex >= execution.logIndex ||
            event.base.contract.toLowerCase() !== execution.contract ||
            event.decoded.standard !== execution.standard ||
            event.decoded.tokenId !== execution.tokenId ||
            event.decoded.amount !== execution.amount
        )
            continue;
        const maker =
            execution.orderSide === ORDER_SIDE.Sell
                ? event.decoded.from
                : event.decoded.to;
        if (maker.toLowerCase() !== execution.maker) continue;
        if (!closest || event.base.logIndex > closest.base.logIndex)
            closest = event;
    }
    return closest;
}

function singleInputComponents(includeTokenRecipient: boolean) {
    const components = [
        { name: "order", type: "tuple", components: orderComponents() },
        { name: "exchange", type: "tuple", components: exchangeComponents() },
        { name: "takerFee", type: "tuple", components: feeComponents },
        { name: "signature", type: "bytes" },
    ];
    if (includeTokenRecipient) {
        components.push({ name: "tokenRecipient", type: "address" });
    }
    return components;
}

function batchInputComponents(includeTokenRecipient: boolean) {
    const components = [
        { name: "orders", type: "tuple[]", components: orderComponents() },
        {
            name: "exchanges",
            type: "tuple[]",
            components: exchangeComponents(),
        },
        { name: "takerFee", type: "tuple", components: feeComponents },
        { name: "signatures", type: "bytes" },
    ];
    if (includeTokenRecipient) {
        components.push({ name: "tokenRecipient", type: "address" });
    }
    return components;
}

function orderComponents() {
    return [
        { name: "trader", type: "address" },
        { name: "collection", type: "address" },
        { name: "listingsRoot", type: "bytes32" },
        { name: "numberOfListings", type: "uint256" },
        { name: "expirationTime", type: "uint256" },
        { name: "assetType", type: "uint8" },
        { name: "makerFee", type: "tuple", components: feeComponents },
        { name: "salt", type: "uint256" },
    ];
}

function exchangeComponents() {
    return [
        { name: "index", type: "uint256" },
        { name: "proof", type: "bytes32[]" },
        { name: "listing", type: "tuple", components: listingComponents() },
        { name: "taker", type: "tuple", components: takerComponents() },
    ];
}

function listingComponents() {
    return [
        { name: "index", type: "uint256" },
        { name: "tokenId", type: "uint256" },
        { name: "amount", type: "uint256" },
        { name: "price", type: "uint256" },
    ];
}

function takerComponents() {
    return [
        { name: "tokenId", type: "uint256" },
        { name: "amount", type: "uint256" },
    ];
}
