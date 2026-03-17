import { decodeEventLog, encodeEventTopics, zeroAddress } from "viem";
import { GLOBAL_MAKER_TRIGGER_REASON } from "../../domain/maker-triggers.js";
import type {
    CancelEvent,
    GlobalMakerTrigger,
} from "../../domain/onchain.js";
import type { Hex, RpcEvent, RpcLog } from "../../ports/rpc.js";
import { SEAPORT_EXCHANGE_ADDRESSES } from "./seaport.js";
import {
    findTrackedNftItem,
    hasTrackedNft,
    isCurrencyItem,
    normalizeCurrency,
    sumAmounts,
    type SeaportItem,
} from "./seaport-shared.js";

type OfferItem = SeaportItem & { endAmount: bigint };

type ConsiderationItem = OfferItem & { recipient: Hex };

type OrderParameters = {
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

export type DecodedOrderInfo = {
    orderId?: string;
    kind?: string;
    maker?: string;
    contract: string;
    tokenId: string;
    price?: string;
    currency?: string;
    blockNumber: number;
    blockHash: string;
    txHash: string;
    logIndex: number;
};

const SEAPORT_EVENT_ABI = [
    {
        type: "event",
        name: "OrderCancelled",
        inputs: [
            { indexed: false, name: "orderHash", type: "bytes32" },
            { indexed: true, name: "offerer", type: "address" },
            { indexed: true, name: "zone", type: "address" },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "CounterIncremented",
        inputs: [
            { indexed: false, name: "newCounter", type: "uint256" },
            { indexed: true, name: "offerer", type: "address" },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "OrderValidated",
        inputs: [
            { indexed: false, name: "orderHash", type: "bytes32" },
            {
                indexed: false,
                name: "orderParameters",
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
        ],
        anonymous: false,
    },
] as const;

const [ORDER_CANCELLED_TOPIC] = encodeEventTopics({
    abi: SEAPORT_EVENT_ABI,
    eventName: "OrderCancelled",
}) as [Hex];

const [COUNTER_INCREMENTED_TOPIC] = encodeEventTopics({
    abi: SEAPORT_EVENT_ABI,
    eventName: "CounterIncremented",
}) as [Hex];

const [ORDER_VALIDATED_TOPIC] = encodeEventTopics({
    abi: SEAPORT_EVENT_ABI,
    eventName: "OrderValidated",
}) as [Hex];

export const SEAPORT_EVENT_FILTERS = SEAPORT_EVENT_ABI as unknown as RpcEvent[];

export type SeaportOrderEvents = {
    cancels: CancelEvent[];
    orders: DecodedOrderInfo[];
    globalMakerTriggers: GlobalMakerTrigger[];
};

// Decode Seaport order lifecycle events from logs (no traces).
export function decodeSeaportOrderEvents(
    logs: RpcLog[],
    collections: Set<string>,
): SeaportOrderEvents {
    const cancels: CancelEvent[] = [];
    const orders: DecodedOrderInfo[] = [];
    const globalMakerTriggers: GlobalMakerTrigger[] = [];

    for (const log of logs) {
        const topic0 = log.topics[0];
        if (!topic0) continue;

        if (topic0 === ORDER_CANCELLED_TOPIC) {
            const cancel = decodeOrderCancelled(log);
            if (cancel) cancels.push(cancel);
            continue;
        }

        if (topic0 === COUNTER_INCREMENTED_TOPIC) {
            const maker = decodeCounterIncremented(log);
            if (maker) globalMakerTriggers.push(maker);
            continue;
        }

        if (topic0 === ORDER_VALIDATED_TOPIC) {
            const order = decodeOrderValidated(log, collections);
            if (order) orders.push(order);
        }
    }

    return { cancels, orders, globalMakerTriggers };
}

// OrderCancelled = explicit on-chain cancellation of a specific Seaport order hash.
function decodeOrderCancelled(log: RpcLog): CancelEvent | null {
    try {
        const decoded = decodeEventLog({
            abi: SEAPORT_EVENT_ABI,
            eventName: "OrderCancelled",
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
        });
        const orderHash = decoded.args.orderHash as Hex;
        const offerer = decoded.args.offerer as Hex;
        return {
            kind: "seaport",
            orderId: orderHash,
            maker: offerer.toLowerCase(),
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
        };
    } catch {
        return null;
    }
}

// CounterIncremented = maker invalidated all prior Seaport orders (counter bump).
function decodeCounterIncremented(log: RpcLog): GlobalMakerTrigger | null {
    try {
        const decoded = decodeEventLog({
            abi: SEAPORT_EVENT_ABI,
            eventName: "CounterIncremented",
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
        });
        const offerer = decoded.args.offerer as Hex;
        return {
            maker: offerer.toLowerCase(),
            reason: GLOBAL_MAKER_TRIGGER_REASON.OrderCounter,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
        };
    } catch {
        return null;
    }
}

// OrderValidated = order created/validated on-chain (useful for on-chain orderbooks).
function decodeOrderValidated(
    log: RpcLog,
    collections: Set<string>,
): DecodedOrderInfo | null {
    try {
        const decoded = decodeEventLog({
            abi: SEAPORT_EVENT_ABI,
            eventName: "OrderValidated",
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
        });
        const orderHash = decoded.args.orderHash as Hex;
        const params = decoded.args.orderParameters as OrderParameters;
        const maker = params.offerer.toLowerCase();

        const offerHasTrackedNft = hasTrackedNft(params.offer, collections);
        const considerationHasTrackedNft = hasTrackedNft(
            params.consideration,
            collections,
        );

        const orderSide =
            offerHasTrackedNft === considerationHasTrackedNft
                ? null
                : offerHasTrackedNft
                  ? "sell"
                  : "buy";

        if (!orderSide) return null;

        const nft =
            orderSide === "sell"
                ? findTrackedNftItem(params.offer, collections)
                : findTrackedNftItem(params.consideration, collections);

        if (!nft) return null;

        const currencyItems =
            orderSide === "sell"
                ? params.consideration.filter((item) =>
                      isCurrencyItem(item.itemType),
                  )
                : params.offer.filter((item) => isCurrencyItem(item.itemType));

        if (currencyItems.length === 0) return null;

        const price = sumAmounts(currencyItems.map((item) => item.startAmount));
        const currency = normalizeCurrency(
            currencyItems[0]?.token ?? zeroAddress,
        );

        return {
            kind: "seaport",
            orderId: orderHash,
            maker,
            contract: nft.contract,
            tokenId: nft.tokenId,
            price: price.toString(),
            currency,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
        };
    } catch {
        return null;
    }
}

export function getSeaportLogAddresses(): Hex[] {
    return Array.from(SEAPORT_EXCHANGE_ADDRESSES).map(
        (address) => address as Hex,
    );
}
