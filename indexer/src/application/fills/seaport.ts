import { logger } from "@artgod/shared/utils";
import { decodeEventLog, encodeEventTopics } from "viem";
import type {
    EnhancedEvent,
    EnhancedTransaction,
} from "../../domain/onchain.js";
import type { Hex, RpcLog } from "../../ports/rpc.js";
import {
    findTrackedNftItems,
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

type SeaportFillCandidate = DecodedFillEvent;

type CandidateTransferMatch = {
    fill: SeaportFillCandidate;
    transfer: EnhancedEvent;
    score: number;
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
    const fills: SeaportFillCandidate[] = [];
    for (const log of tx.receiptLogs) {
        fills.push(...decodeOrderFulfilled(log, tx, collections));
    }
    return canonicalizeProtocolFills(tx, fills);
}

function decodeOrderFulfilled(
    log: RpcLog,
    tx: EnhancedTransaction,
    collections: Set<string>,
): SeaportFillCandidate[] {
    if (!SEAPORT_EXCHANGE_ADDRESSES.has(log.address.toLowerCase())) return [];
    if (log.topics[0] !== ORDER_FULFILLED_TOPIC) return [];

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

        const offeredNfts = findTrackedNftItems(offer, collections);
        const consideredNfts = findTrackedNftItems(consideration, collections);
        if (offeredNfts.length > 0 && consideredNfts.length > 0) return [];
        if (offeredNfts.length === 0 && consideredNfts.length === 0) return [];

        const orderSide: OrderSide = offeredNfts.length > 0 ? "sell" : "buy";
        const nfts = orderSide === "sell" ? offeredNfts : consideredNfts;

        const currencyItems =
            orderSide === "sell"
                ? consideration.filter((item) => isCurrencyItem(item.itemType))
                : offer.filter((item) => isCurrencyItem(item.itemType));
        if (currencyItems.length === 0) return [];
        const currency = resolveSingleCurrency(log, currencyItems, tx);
        if (!currency) return [];

        const price = sumAmounts(currencyItems.map((item) => item.startAmount));

        return nfts.flatMap((nft) => {
            return [
                {
                    kind: "seaport",
                    orderId: decoded.args.orderHash as Hex,
                    orderSide,
                    maker: offerer,
                    taker: tx.transaction.from.toLowerCase(),
                    contract: nft.contract,
                    tokenId: nft.tokenId,
                    amount: nft.amount,
                    price: price.toString(),
                    currency,
                    blockNumber: tx.blockNumber,
                    blockHash: tx.blockHash,
                    txHash: tx.txHash,
                    logIndex: log.logIndex,
                },
            ];
        });
    } catch {
        return [];
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

function canonicalizeProtocolFills(
    tx: EnhancedTransaction,
    fills: SeaportFillCandidate[],
): DecodedFillEvent[] {
    const groups = new Map<string, DecodedFillEvent[]>();
    for (const fill of fills) {
        const key = `${fill.contract}:${fill.tokenId}`;
        const existing = groups.get(key);
        if (existing) {
            existing.push(fill);
        } else {
            groups.set(key, [fill]);
        }
    }

    const canonical: DecodedFillEvent[] = [];
    for (const group of groups.values()) {
        for (const fill of matchAndCanonicalizeTokenFills(tx, group)) {
            canonical.push(fill);
        }
    }
    return canonical.sort((a, b) => a.logIndex - b.logIndex);
}

function matchAndCanonicalizeTokenFills(
    tx: EnhancedTransaction,
    group: SeaportFillCandidate[],
): DecodedFillEvent[] {
    const [first] = group;
    if (!first) return [];

    const transfers = getMatchingTransfers(tx.events, first).sort(
        (a, b) => a.base.logIndex - b.base.logIndex,
    );
    const matches = chooseBestTransferMatches(tx, group, transfers);
    if (matches.length === 0) return [];

    const byTransfer = new Map<number, CandidateTransferMatch[]>();
    for (const match of matches) {
        const existing = byTransfer.get(match.transfer.base.logIndex);
        if (existing) {
            existing.push(match);
        } else {
            byTransfer.set(match.transfer.base.logIndex, [match]);
        }
    }

    const out: DecodedFillEvent[] = [];
    for (const transferMatches of byTransfer.values()) {
        out.push(...chooseCanonicalTransferFills(tx, transferMatches));
    }
    return out;
}

function chooseBestTransferMatches(
    tx: EnhancedTransaction,
    fills: SeaportFillCandidate[],
    transfers: EnhancedEvent[],
): CandidateTransferMatch[] {
    const options = fills.map((fill) =>
        transfers
            .flatMap((transfer) => {
                const score = scoreCandidateTransfer(tx, fill, transfer);
                return score === null ? [] : [{ fill, transfer, score }];
            })
            .sort((a, b) => b.score - a.score),
    );

    let best: CandidateTransferMatch[] = [];
    let bestScore = Number.NEGATIVE_INFINITY;

    function walk(
        index: number,
        usedTransfers: Set<number>,
        picked: CandidateTransferMatch[],
        score: number,
    ) {
        if (index >= fills.length) {
            if (
                picked.length > best.length ||
                (picked.length === best.length &&
                    (score > bestScore ||
                        (score === bestScore &&
                            compareTransferMatchSets(picked, best) > 0)))
            ) {
                best = [...picked];
                bestScore = score;
            }
            return;
        }

        // Skipping a candidate lets matched-order mirror logs lose to the real transfer hop.
        walk(index + 1, usedTransfers, picked, score);

        for (const option of options[index] ?? []) {
            const transferKey = option.transfer.base.logIndex;
            if (usedTransfers.has(transferKey)) continue;

            usedTransfers.add(transferKey);
            picked.push(option);
            walk(index + 1, usedTransfers, picked, score + option.score);
            picked.pop();
            usedTransfers.delete(transferKey);
        }
    }

    walk(0, new Set(), [], 0);
    return best.map(({ fill, transfer, score }) => ({
        fill: applyTransferTaker(tx, fill, transfer),
        transfer,
        score,
    }));
}

function compareTransferMatchSets(
    left: readonly CandidateTransferMatch[],
    right: readonly CandidateTransferMatch[],
): number {
    let score = 0;
    for (const leftMatch of left) {
        const rightMatch = right.find(
            (match) =>
                match.transfer.base.logIndex ===
                leftMatch.transfer.base.logIndex,
        );
        if (!rightMatch) continue;
        score += compareGrossBidCandidate(leftMatch.fill, rightMatch.fill);
    }
    return score;
}

function compareGrossBidCandidate(
    left: DecodedFillEvent,
    right: DecodedFillEvent,
): number {
    if (left.orderSide === right.orderSide) return 0;
    if (left.currency !== right.currency) return 0;

    const buy = left.orderSide === "buy" ? left : right;
    const sell = left.orderSide === "sell" ? left : right;
    if (!isGrossBidCandidate(buy, sell)) return 0;

    // Same-transfer bid settlements expose gross bid and net seller proceeds as peers.
    return left.orderSide === "buy" ? 1 : -1;
}

function scoreCandidateTransfer(
    tx: EnhancedTransaction,
    fill: SeaportFillCandidate,
    transfer: EnhancedEvent,
): number | null {
    const maker = fill.maker?.toLowerCase();
    if (!maker) return null;

    const from = transfer.decoded.from.toLowerCase();
    const to = transfer.decoded.to.toLowerCase();
    const txFrom = tx.transaction.from.toLowerCase();
    let score: number | null = null;

    if (fill.orderSide === "sell" && from === maker) {
        score = 100;
    } else if (fill.orderSide === "buy" && to === maker) {
        score = 100;
    } else if (fill.orderSide === "buy" && from === maker) {
        score = 90;
    }
    if (score === null) return null;

    // When one transfer has matched buy/sell logs, tx.from direction selects the taker side.
    if (fill.orderSide === "buy" && from === txFrom) score += 25;
    if (fill.orderSide === "sell" && to === txFrom) score += 25;
    if (fill.orderSide === "sell" && from === txFrom) score -= 25;
    return score;
}

function applyTransferTaker(
    tx: EnhancedTransaction,
    fill: SeaportFillCandidate,
    transfer: EnhancedEvent,
): SeaportFillCandidate {
    const from = transfer.decoded.from.toLowerCase();
    const to = transfer.decoded.to.toLowerCase();
    const maker = fill.maker?.toLowerCase();
    const taker =
        fill.orderSide === "sell"
            ? to
            : from === maker
              ? tx.transaction.from.toLowerCase()
              : from;

    return { ...fill, taker };
}

function chooseCanonicalTransferFills(
    tx: EnhancedTransaction,
    matches: CandidateTransferMatch[],
): DecodedFillEvent[] {
    const group = matches.map((match) => match.fill);
    const hasBuy = group.some((fill) => fill.orderSide === "buy");
    const hasSell = group.some((fill) => fill.orderSide === "sell");
    if (group.length <= 1 || !hasBuy || !hasSell) return group;

    // Matched Seaport orders can emit buy and sell logs for one NFT transfer; keep one fill.
    const txFromDirection = resolveTxFromTransferDirection(tx, matches[0]!);
    if (txFromDirection) {
        const expectedSide = txFromDirection === "from" ? "buy" : "sell";
        const matching = group.filter(
            (fill) => fill.orderSide === expectedSide,
        );
        if (matching.length === 1) return matching;
    }

    const grossBid = resolveGrossBidTieBreak(group);
    if (grossBid) return [grossBid];

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

function resolveGrossBidTieBreak(
    group: DecodedFillEvent[],
): DecodedFillEvent | null {
    const buys = group.filter((fill) => fill.orderSide === "buy");
    const sells = group.filter((fill) => fill.orderSide === "sell");
    if (buys.length !== 1 || sells.length !== 1) return null;

    const [buy] = buys;
    const [sell] = sells;
    if (!buy || !sell) return null;
    if (buy.currency !== sell.currency) return null;

    // Delegated custodian bid settlements expose gross bid and seller proceeds in one transfer.
    return isGrossBidCandidate(buy, sell) ? buy : null;
}

function isGrossBidCandidate(
    buy: DecodedFillEvent,
    sell: DecodedFillEvent,
): boolean {
    if (!buy.price || !sell.price) return false;
    return BigInt(buy.price) > BigInt(sell.price);
}

function resolveTxFromTransferDirection(
    tx: EnhancedTransaction,
    match: CandidateTransferMatch,
): "from" | "to" | null {
    const txFrom = tx.transaction.from.toLowerCase();
    const transfer = match.transfer;
    if (transfer.decoded.from.toLowerCase() === txFrom) return "from";
    if (transfer.decoded.to.toLowerCase() === txFrom) return "to";
    return null;
}
