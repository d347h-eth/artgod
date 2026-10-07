import {
    decodeEventLog,
    decodeFunctionData,
    parseAbi,
    zeroAddress,
} from "viem";
import type { EnhancedTransaction } from "../../domain/onchain.js";
import { COLLECTION_STANDARD } from "../../domain/collections.js";
import type { Hex, RpcLog } from "../../ports/rpc.js";
import type { DecodedFillEvent, OrderSide } from "./types.js";
import {
    BLUR_BETH_ADDRESS,
    FILL_KIND,
    FILL_ITEM_SIDE,
    FILL_ITEM_TYPE,
    type FillExecution,
} from "@artgod/shared/market-data/fills";
export { BLUR_BETH_ADDRESS } from "@artgod/shared/market-data/fills";

type BlurOrder = {
    trader: Hex;
    collection: Hex;
    listingsRoot: Hex;
    numberOfListings: bigint;
    expirationTime: bigint;
    assetType: number;
    makerFee: { recipient: Hex; rate: number };
    salt: bigint;
};

type BlurExchange = {
    index: bigint;
    proof: Hex[];
    listing: {
        index: bigint;
        tokenId: bigint;
        amount: bigint;
        price: bigint;
    };
    taker: {
        tokenId: bigint;
        amount: bigint;
    };
};

type BlurSingleInputs = {
    order: BlurOrder;
    exchange: BlurExchange;
    takerFee: { recipient: Hex; rate: number };
    signature: Hex;
    tokenRecipient?: Hex;
};

type BlurBatchInputs = {
    orders: BlurOrder[];
    exchanges: BlurExchange[];
    takerFee: { recipient: Hex; rate: number };
    signatures: Hex;
    tokenRecipient?: Hex;
};

type BlurFillInput = {
    order: BlurOrder;
    exchange: BlurExchange;
    orderSide: OrderSide;
    currency: string;
    taker: string;
};

type BlurExecutionLog = {
    orderHash: Hex;
    logIndex: number;
    maker: string;
    contract: string;
    tokenId: string;
    listingIndex: bigint;
    amount: bigint;
    price: bigint;
    orderSide: OrderSide;
    assetType: number;
    log: RpcLog;
};

export const BLUR_EXCHANGE_V2_ADDRESSES = new Set(
    ["0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5"].map((address) =>
        address.toLowerCase(),
    ),
);

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
    {
        type: "event",
        name: "Execution721Packed",
        inputs: [
            { indexed: false, name: "orderHash", type: "bytes32" },
            {
                indexed: false,
                name: "tokenIdListingIndexTrader",
                type: "uint256",
            },
            { indexed: false, name: "collectionPriceSide", type: "uint256" },
        ],
        anonymous: false,
    },
] as const;

// The generic Execution event covers ERC1155, both fees, and values that cannot
// fit the packed ERC721 representation. All variants identify a successful trade.
export const BLUR_EXECUTION_ABI = parseAbi([
    "event Execution721Packed(bytes32 orderHash, uint256 tokenIdListingIndexTrader, uint256 collectionPriceSide)",
    "event Execution721TakerFeePacked(bytes32 orderHash, uint256 tokenIdListingIndexTrader, uint256 collectionPriceSide, uint256 takerFeeRecipientRate)",
    "event Execution721MakerFeePacked(bytes32 orderHash, uint256 tokenIdListingIndexTrader, uint256 collectionPriceSide, uint256 makerFeeRecipientRate)",
    "event Execution((address trader,uint256 id,uint256 amount,address collection,uint8 assetType) transfer, bytes32 orderHash, uint256 listingIndex, uint256 price, (address recipient,uint16 rate) makerFee, ((address recipient,uint16 rate) protocolFee,(address recipient,uint16 rate) takerFee) fees, uint8 orderType)",
]);

// Decode direct Blur V2 calls from calldata; routed Blur remains explicit follow-up work.
export function decodeBlurFills(
    tx: EnhancedTransaction,
    collections: Set<string>,
): DecodedFillEvent[] {
    const to = tx.transaction.to?.toLowerCase();
    if (!to || !BLUR_EXCHANGE_V2_ADDRESSES.has(to)) return [];

    let decoded: ReturnType<typeof decodeFunctionData> | null = null;
    try {
        decoded = decodeFunctionData({
            abi: BLUR_EXCHANGE_V2_ABI,
            data: tx.transaction.input,
        });
    } catch {
        return [];
    }

    const executionLogs = decodeBlurExecutionLogs(tx.receiptLogs);
    const used = new Set<number>();
    return toBlurFillInputs(tx, decoded).flatMap((input) => {
        // Match before tracking filters; unsuccessful batch exchanges have no
        // execution event and must never consume a later successful trade's log.
        const execution = executionLogs.find(
            (log) => !used.has(log.logIndex) && matchesExecution(input, log),
        );
        if (!execution) return [];
        used.add(execution.logIndex);
        return toBlurFill(tx, input, execution, collections);
    });
}

function matchesExecution(
    input: BlurFillInput,
    log: BlurExecutionLog,
): boolean {
    return (
        log.maker === input.order.trader.toLowerCase() &&
        log.contract === input.order.collection.toLowerCase() &&
        log.tokenId === input.exchange.taker.tokenId.toString() &&
        log.listingIndex === input.exchange.listing.index &&
        log.orderSide === input.orderSide &&
        log.assetType === input.order.assetType &&
        log.amount === input.exchange.taker.amount &&
        log.price === input.exchange.listing.price * input.exchange.taker.amount
    );
}

function toBlurFillInputs(
    tx: EnhancedTransaction,
    decoded: ReturnType<typeof decodeFunctionData>,
): BlurFillInput[] {
    const functionName = decoded.functionName;
    const txFrom = tx.transaction.from.toLowerCase();

    if (functionName === "takeAskSingle") {
        const input = decoded.args[0] as BlurSingleInputs;
        return [
            toSingleInput(
                input,
                "sell",
                zeroAddress,
                resolveAskTaker(input, txFrom),
            ),
        ];
    }

    if (functionName === "takeBidSingle") {
        const input = decoded.args[0] as BlurSingleInputs;
        return [toSingleInput(input, "buy", BLUR_BETH_ADDRESS, txFrom)];
    }

    if (functionName === "takeAskSinglePool") {
        const input = decoded.args[0] as BlurSingleInputs;
        return [
            toSingleInput(
                input,
                "sell",
                BLUR_BETH_ADDRESS,
                resolveAskTaker(input, txFrom),
            ),
        ];
    }

    if (functionName === "takeAsk") {
        const input = decoded.args[0] as BlurBatchInputs;
        return toBatchInputs(
            input,
            "sell",
            zeroAddress,
            resolveAskTaker(input, txFrom),
        );
    }

    if (functionName === "takeBid") {
        const input = decoded.args[0] as BlurBatchInputs;
        return toBatchInputs(input, "buy", BLUR_BETH_ADDRESS, txFrom);
    }

    return [];
}

function toSingleInput(
    input: BlurSingleInputs,
    orderSide: OrderSide,
    currency: string,
    taker: string,
): BlurFillInput {
    return {
        order: input.order,
        exchange: input.exchange,
        orderSide,
        currency,
        taker,
    };
}

function toBatchInputs(
    input: BlurBatchInputs,
    orderSide: OrderSide,
    currency: string,
    taker: string,
): BlurFillInput[] {
    return input.exchanges.flatMap((exchange) => {
        const order = input.orders[toSafeIndex(exchange.index)];
        if (!order) return [];
        return [{ order, exchange, orderSide, currency, taker }];
    });
}

function toBlurFill(
    tx: EnhancedTransaction,
    input: BlurFillInput,
    execution: BlurExecutionLog,
    collections: Set<string>,
): DecodedFillEvent[] {
    const contract = input.order.collection.toLowerCase();
    const tokenId = input.exchange.taker.tokenId.toString();
    if (!collections.has(contract)) return [];
    if (!hasMatchingTransfer(tx, input, execution)) return [];
    const executionContext: FillExecution = {
        protocolAddress: execution.log.address.toLowerCase(),
        items: [
            {
                index: 0,
                side:
                    input.orderSide === "sell"
                        ? FILL_ITEM_SIDE.Offer
                        : FILL_ITEM_SIDE.Consideration,
                itemType:
                    execution.assetType === 0
                        ? FILL_ITEM_TYPE.Erc721
                        : FILL_ITEM_TYPE.Erc1155,
                contract,
                identifier: tokenId,
                amount: execution.amount.toString(),
                recipient:
                    input.orderSide === "sell"
                        ? input.taker
                        : input.order.trader.toLowerCase(),
            },
            {
                index: 1,
                side:
                    input.orderSide === "sell"
                        ? FILL_ITEM_SIDE.Consideration
                        : FILL_ITEM_SIDE.Offer,
                itemType:
                    input.currency === zeroAddress
                        ? FILL_ITEM_TYPE.Native
                        : FILL_ITEM_TYPE.Erc20,
                contract: input.currency,
                identifier: "0",
                amount: execution.price.toString(),
                recipient:
                    input.orderSide === "sell"
                        ? input.order.trader.toLowerCase()
                        : input.taker,
            },
        ],
    };

    return [
        {
            kind: FILL_KIND.BlurV2,
            orderId: execution.orderHash,
            orderSide: input.orderSide,
            maker: input.order.trader.toLowerCase(),
            taker: input.taker,
            contract,
            tokenId,
            amount: input.exchange.taker.amount.toString(),
            // listing.price is per NFT unit. Execution.price is its gross total,
            // already multiplied by the actually executed taker quantity.
            price: execution.price.toString(),
            execution: executionContext,
            executionItemIndex: 0,
            currency: input.currency,
            blockNumber: tx.blockNumber,
            blockHash: tx.blockHash,
            txHash: tx.txHash,
            logIndex: execution.logIndex,
        },
    ];
}

function resolveAskTaker(
    input: { tokenRecipient?: Hex },
    txFrom: string,
): string {
    return input.tokenRecipient?.toLowerCase() ?? txFrom;
}

function hasMatchingTransfer(
    tx: EnhancedTransaction,
    input: BlurFillInput,
    execution: BlurExecutionLog,
): boolean {
    const maker = input.order.trader.toLowerCase();
    const seller = input.orderSide === "sell" ? maker : input.taker;
    const buyer = input.orderSide === "sell" ? input.taker : maker;
    return tx.events.some(
        (event) =>
            event.base.contract.toLowerCase() === execution.contract &&
            event.decoded.tokenId === execution.tokenId &&
            event.decoded.from.toLowerCase() === seller &&
            event.decoded.to.toLowerCase() === buyer &&
            event.decoded.amount === execution.amount.toString() &&
            event.kind ===
                (execution.assetType === 0
                    ? COLLECTION_STANDARD.Erc721
                    : COLLECTION_STANDARD.Erc1155),
    );
}

function decodeBlurExecutionLogs(logs: RpcLog[]): BlurExecutionLog[] {
    const out: BlurExecutionLog[] = [];
    for (const log of logs) {
        if (!BLUR_EXCHANGE_V2_ADDRESSES.has(log.address.toLowerCase()))
            continue;
        try {
            const decoded = decodeEventLog({
                abi: BLUR_EXECUTION_ABI,
                data: log.data,
                topics: log.topics as [Hex, ...Hex[]],
            });
            if (decoded.eventName === "Execution") {
                const args = decoded.args;
                out.push({
                    log,
                    orderHash: args.orderHash,
                    logIndex: log.logIndex,
                    maker: args.transfer.trader.toLowerCase(),
                    contract: args.transfer.collection.toLowerCase(),
                    tokenId: args.transfer.id.toString(),
                    listingIndex: args.listingIndex,
                    amount:
                        args.transfer.assetType === 0
                            ? 1n
                            : args.transfer.amount,
                    price: args.price,
                    orderSide: args.orderType === 0 ? "sell" : "buy",
                    assetType: args.transfer.assetType,
                });
            } else {
                const args = decoded.args;
                const token = args.tokenIdListingIndexTrader;
                const price = args.collectionPriceSide;
                const address = (value: bigint) =>
                    `0x${(value & ((1n << 160n) - 1n)).toString(16).padStart(40, "0")}`;
                out.push({
                    log,
                    orderHash: args.orderHash,
                    logIndex: log.logIndex,
                    maker: address(token),
                    contract: address(price),
                    tokenId: (token >> 168n).toString(),
                    listingIndex: (token >> 160n) & 255n,
                    amount: 1n,
                    price: (price >> 160n) & ((1n << 88n) - 1n),
                    orderSide: price >> 248n === 0n ? "sell" : "buy",
                    assetType: 0,
                });
            }
        } catch {
            continue;
        }
    }
    return out.sort((a, b) => a.logIndex - b.logIndex);
}

function toSafeIndex(value: bigint): number {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return -1;
    return Number(value);
}

function singleInputComponents(includeTokenRecipient: boolean) {
    const components = [
        { name: "order", type: "tuple", components: orderComponents() },
        { name: "exchange", type: "tuple", components: exchangeComponents() },
        { name: "takerFee", type: "tuple", components: feeComponents() },
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
        { name: "takerFee", type: "tuple", components: feeComponents() },
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
        { name: "makerFee", type: "tuple", components: feeComponents() },
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

function feeComponents() {
    return [
        { name: "recipient", type: "address" },
        { name: "rate", type: "uint16" },
    ];
}
