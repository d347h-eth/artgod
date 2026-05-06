import { logger } from "@artgod/shared/utils";
import { decodeEventLog, encodeEventTopics, zeroAddress } from "viem";
import type {
    EnhancedEvent,
    EnhancedTransaction,
} from "../../domain/onchain.js";
import type { Hex, RpcLog } from "../../ports/rpc.js";
import {
    findTrackedNftItem,
    isCurrencyItem,
    normalizeCurrency,
    sumAmounts,
    type SeaportItem,
} from "./seaport-shared.js";
import type { DecodedFillEvent, OrderSide } from "./types.js";

type OrderFulfilledItem = {
    itemType: number;
    token: Hex;
    identifier: bigint;
    amount: bigint;
};

type OrderFulfilledConsiderationItem = OrderFulfilledItem & {
    recipient: Hex;
};

type SeaportFillCandidate = DecodedFillEvent & {
    priceValue: bigint;
};

const SEAPORT_ORDER_FULFILLED_ABI = [
    {
        type: "event",
        name: "OrderFulfilled",
        inputs: [
            { indexed: false, name: "orderHash", type: "bytes32" },
            { indexed: true, name: "offerer", type: "address" },
            { indexed: true, name: "zone", type: "address" },
            { indexed: false, name: "recipient", type: "address" },
            {
                indexed: false,
                name: "offer",
                type: "tuple[]",
                components: [
                    { name: "itemType", type: "uint8" },
                    { name: "token", type: "address" },
                    { name: "identifier", type: "uint256" },
                    { name: "amount", type: "uint256" },
                ],
            },
            {
                indexed: false,
                name: "consideration",
                type: "tuple[]",
                components: [
                    { name: "itemType", type: "uint8" },
                    { name: "token", type: "address" },
                    { name: "identifier", type: "uint256" },
                    { name: "amount", type: "uint256" },
                    { name: "recipient", type: "address" },
                ],
            },
        ],
        anonymous: false,
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

const [ORDER_FULFILLED_TOPIC] = encodeEventTopics({
    abi: SEAPORT_ORDER_FULFILLED_ABI,
    eventName: "OrderFulfilled",
}) as [Hex];

// Decode Seaport fills from receipt logs so routed calls work without traces.
export function decodeSeaportFills(
    tx: EnhancedTransaction,
    collections: Set<string>,
): DecodedFillEvent[] {
    const candidates: SeaportFillCandidate[] = [];
    for (const log of tx.receiptLogs) {
        const candidate = decodeOrderFulfilled(log, tx, collections);
        if (candidate) candidates.push(candidate);
    }
    return dedupeMatchedOrderCandidates(tx, candidates);
}

function decodeOrderFulfilled(
    log: RpcLog,
    tx: EnhancedTransaction,
    collections: Set<string>,
): SeaportFillCandidate | null {
    if (!SEAPORT_EXCHANGE_ADDRESSES.has(log.address.toLowerCase())) return null;
    if (log.topics[0] !== ORDER_FULFILLED_TOPIC) return null;

    try {
        const decoded = decodeEventLog({
            abi: SEAPORT_ORDER_FULFILLED_ABI,
            eventName: "OrderFulfilled",
            data: log.data,
            topics: log.topics as [Hex, ...Hex[]],
        });

        const offerer = (decoded.args.offerer as Hex).toLowerCase();
        const offer = normalizeFulfilledItems(
            decoded.args.offer as readonly OrderFulfilledItem[],
        );
        const consideration = normalizeFulfilledItems(
            decoded.args
                .consideration as readonly OrderFulfilledConsiderationItem[],
        );

        const offeredNft = findTrackedNftItem(offer, collections);
        const consideredNft = findTrackedNftItem(consideration, collections);
        if (Boolean(offeredNft) === Boolean(consideredNft)) return null;

        const orderSide: OrderSide = offeredNft ? "sell" : "buy";
        const nft = offeredNft ?? consideredNft;
        // Require the Seaport order NFT to appear in the tracked transfer set for this tx.
        if (!nft || !hasMatchingTransfer(tx.events, nft)) return null;

        const currencyItems =
            orderSide === "sell"
                ? consideration.filter((item) => isCurrencyItem(item.itemType))
                : offer.filter((item) => isCurrencyItem(item.itemType));
        if (currencyItems.length === 0) return null;
        const currency = resolveSingleCurrency(log, currencyItems, tx);
        if (!currency) return null;

        const price = sumAmounts(currencyItems.map((item) => item.startAmount));

        return {
            kind: "seaport",
            orderId: decoded.args.orderHash as Hex,
            orderSide,
            maker: offerer,
            taker: resolveSeaportTaker(tx, orderSide, nft, offerer),
            contract: nft.contract,
            tokenId: nft.tokenId,
            amount: nft.amount,
            price: price.toString(),
            priceValue: price,
            currency,
            blockNumber: tx.blockNumber,
            blockHash: tx.blockHash,
            txHash: tx.txHash,
            logIndex: log.logIndex,
        };
    } catch {
        return null;
    }
}

function resolveSingleCurrency(
    log: RpcLog,
    currencyItems: readonly SeaportItem[],
    tx: EnhancedTransaction,
): string | null {
    const currencies = new Set(
        currencyItems.map((item) => normalizeCurrency(item.token)),
    );
    const [currency] = currencies;
    if (currency && currencies.size === 1) return currency;

    logger.warn("Mixed-currency Seaport fill skipped", {
        component: "SeaportFillDecoder",
        action: "decodeSeaportFills",
        txHash: tx.txHash,
        logIndex: log.logIndex,
        currencies: [...currencies],
    });
    return null;
}

function normalizeFulfilledItems(
    items: readonly OrderFulfilledItem[],
): SeaportItem[] {
    return items.map((item) => ({
        itemType: Number(item.itemType),
        token: item.token,
        identifierOrCriteria: item.identifier,
        startAmount: item.amount,
    }));
}

function hasMatchingTransfer(
    events: readonly EnhancedEvent[],
    nft: { contract: string; tokenId: string },
): boolean {
    return getMatchingTransfers(events, nft).length > 0;
}

function getMatchingTransfers(
    events: readonly EnhancedEvent[],
    nft: { contract: string; tokenId: string },
): EnhancedEvent[] {
    const contract = nft.contract.toLowerCase();
    return events.filter(
        (event) =>
            event.base.contract.toLowerCase() === contract &&
            event.decoded.tokenId === nft.tokenId,
    );
}

function resolveSeaportTaker(
    tx: EnhancedTransaction,
    orderSide: OrderSide,
    nft: { contract: string; tokenId: string },
    maker: string,
): string {
    return orderSide === "sell"
        ? resolveSellTaker(tx, nft, maker)
        : resolveBuyTaker(tx, nft);
}

function resolveSellTaker(
    tx: EnhancedTransaction,
    nft: { contract: string; tokenId: string },
    maker: string,
): string {
    const txFrom = tx.transaction.from.toLowerCase();
    const transfers = getMatchingTransfers(tx.events, nft);
    if (transfers.some((event) => event.decoded.to.toLowerCase() === txFrom)) {
        return txFrom;
    }

    const makerTransfer = transfers.find(
        (event) => event.decoded.from.toLowerCase() === maker,
    );
    return makerTransfer?.decoded.to.toLowerCase() ?? txFrom;
}

function resolveBuyTaker(
    tx: EnhancedTransaction,
    nft: { contract: string; tokenId: string },
): string {
    const txFrom = tx.transaction.from.toLowerCase();
    const transfers = getMatchingTransfers(tx.events, nft);
    if (
        transfers.some((event) => event.decoded.from.toLowerCase() === txFrom)
    ) {
        return txFrom;
    }

    const makerTransfer = transfers.find(
        (event) => event.decoded.to.toLowerCase() !== zeroAddress,
    );
    return makerTransfer?.decoded.from.toLowerCase() ?? txFrom;
}

function dedupeMatchedOrderCandidates(
    tx: EnhancedTransaction,
    candidates: SeaportFillCandidate[],
): DecodedFillEvent[] {
    const groups = new Map<string, SeaportFillCandidate[]>();
    for (const candidate of candidates) {
        const key = `${candidate.contract}:${candidate.tokenId}`;
        const existing = groups.get(key);
        if (existing) {
            existing.push(candidate);
        } else {
            groups.set(key, [candidate]);
        }
    }

    const fills: DecodedFillEvent[] = [];
    for (const group of groups.values()) {
        for (const candidate of chooseCanonicalCandidates(tx, group)) {
            fills.push(stripCandidateMetadata(candidate));
        }
    }
    return fills.sort((a, b) => a.logIndex - b.logIndex);
}

function chooseCanonicalCandidates(
    tx: EnhancedTransaction,
    group: SeaportFillCandidate[],
): SeaportFillCandidate[] {
    const hasBuy = group.some((candidate) => candidate.orderSide === "buy");
    const hasSell = group.some((candidate) => candidate.orderSide === "sell");
    if (group.length <= 1 || !hasBuy || !hasSell) return group;

    // Routed wrappers may emit their own mirror order; keep the external marketplace order.
    const outerTo = tx.transaction.to?.toLowerCase();
    if (outerTo && !SEAPORT_EXCHANGE_ADDRESSES.has(outerTo)) {
        const nonWrapperCandidates = group.filter(
            (candidate) => candidate.maker?.toLowerCase() !== outerTo,
        );
        if (nonWrapperCandidates.length === 1) return nonWrapperCandidates;
    }

    // Direct matched orders are canonicalized by the taker's NFT transfer direction.
    const txFromDirection = resolveTxFromFirstTransferDirection(tx, group[0]!);
    if (txFromDirection) {
        const expectedSide = txFromDirection === "from" ? "buy" : "sell";
        const matching = group.filter(
            (candidate) => candidate.orderSide === expectedSide,
        );
        if (matching.length === 1) return matching;
    }

    logger.warn("Ambiguous matched Seaport fill skipped", {
        component: "SeaportFillDecoder",
        action: "decodeSeaportFills",
        txHash: tx.txHash,
        candidates: group.length,
        contract: group[0]?.contract,
        tokenId: group[0]?.tokenId,
    });
    return [];
}

function resolveTxFromFirstTransferDirection(
    tx: EnhancedTransaction,
    candidate: SeaportFillCandidate,
): "from" | "to" | null {
    const txFrom = tx.transaction.from.toLowerCase();
    const transfers = getMatchingTransfers(tx.events, candidate).sort(
        (a, b) => a.base.logIndex - b.base.logIndex,
    );

    for (const transfer of transfers) {
        if (transfer.decoded.from.toLowerCase() === txFrom) return "from";
        if (transfer.decoded.to.toLowerCase() === txFrom) return "to";
    }
    return null;
}

function stripCandidateMetadata(
    candidate: SeaportFillCandidate,
): DecodedFillEvent {
    const { priceValue: _priceValue, ...fill } = candidate;
    return fill;
}
