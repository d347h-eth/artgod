import {
    decodeEventLog,
    decodeFunctionData,
    encodeEventTopics,
    zeroAddress,
} from "viem";
import type { EnhancedTransaction } from "../../domain/onchain.js";
import type { Hex, RpcLog } from "../../ports/rpc.js";
import type { DecodedFillEvent, OrderSide } from "./types.js";

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
};

export const BLUR_EXCHANGE_V2_ADDRESSES = new Set(
    ["0xb2ecfe4e4d61f8790bbb9de2d1259b9e2410cea5"].map((address) =>
        address.toLowerCase(),
    ),
);

export const BLUR_BETH_ADDRESS = "0x0000000000a39bb272e79075ade125fd351887ac";

const BLUR_EXCHANGE_V2_ABI = [
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

const [EXECUTION_721_PACKED_TOPIC] = encodeEventTopics({
    abi: BLUR_EXCHANGE_V2_ABI,
    eventName: "Execution721Packed",
}) as [Hex];

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

    const fills = toBlurFillInputs(tx, decoded).flatMap((input) =>
        toBlurFill(tx, input, collections),
    );
    const executionLogs = decodeBlurExecutionLogs(tx.receiptLogs);
    return fills.map((fill, index) => ({
        ...fill,
        orderId: executionLogs[index]?.orderHash ?? fill.orderId,
        logIndex: executionLogs[index]?.logIndex ?? fill.logIndex,
    }));
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
    collections: Set<string>,
): DecodedFillEvent[] {
    const contract = input.order.collection.toLowerCase();
    const tokenId = input.exchange.taker.tokenId.toString();
    if (!collections.has(contract)) return [];
    if (!hasMatchingTransfer(tx, contract, tokenId)) return [];

    return [
        {
            kind: "blur-v2",
            orderSide: input.orderSide,
            maker: input.order.trader.toLowerCase(),
            taker: input.taker,
            contract,
            tokenId,
            amount: input.exchange.taker.amount.toString(),
            price: input.exchange.listing.price.toString(),
            currency: input.currency,
            blockNumber: tx.blockNumber,
            blockHash: tx.blockHash,
            txHash: tx.txHash,
            logIndex: firstMatchingTransferLogIndex(tx, contract, tokenId),
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
    contract: string,
    tokenId: string,
): boolean {
    return tx.events.some(
        (event) =>
            event.base.contract.toLowerCase() === contract &&
            event.decoded.tokenId === tokenId,
    );
}

function firstMatchingTransferLogIndex(
    tx: EnhancedTransaction,
    contract: string,
    tokenId: string,
): number {
    const event = tx.events.find(
        (candidate) =>
            candidate.base.contract.toLowerCase() === contract &&
            candidate.decoded.tokenId === tokenId,
    );
    return event?.base.logIndex ?? 0;
}

function decodeBlurExecutionLogs(logs: RpcLog[]): BlurExecutionLog[] {
    const out: BlurExecutionLog[] = [];
    for (const log of logs) {
        if (!BLUR_EXCHANGE_V2_ADDRESSES.has(log.address.toLowerCase()))
            continue;
        if (log.topics[0] !== EXECUTION_721_PACKED_TOPIC) continue;
        try {
            const decoded = decodeEventLog({
                abi: BLUR_EXCHANGE_V2_ABI,
                eventName: "Execution721Packed",
                data: log.data,
                topics: log.topics as [Hex, ...Hex[]],
            });
            out.push({
                orderHash: decoded.args.orderHash as Hex,
                logIndex: log.logIndex,
            });
        } catch {
            continue;
        }
    }
    return out;
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
