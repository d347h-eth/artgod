import { decodeEventLog, zeroAddress } from "viem";
import {
    FILL_ITEM_SIDE,
    FILL_ITEM_TYPE,
    FILL_KIND,
    type FillExecution,
} from "@artgod/shared/market-data/fills";
import { ORDER_SIDE } from "@artgod/shared/market-data/orders";
import { COLLECTION_STANDARD } from "../../domain/collections.js";
import type {
    EnhancedEvent,
    EnhancedTransaction,
} from "../../domain/onchain.js";
import type { Hex, RpcLog } from "../../ports/rpc.js";
import { decodeNftTransferLog } from "../nft-transfers.js";
import {
    WYVERN_EVENT_NAME,
    WYVERN_EXCHANGE_ABI,
    WYVERN_EXCHANGE_ADDRESSES,
} from "./wyvern-abi.js";
import {
    decodeWyvernMatchCalls,
    type WyvernMatchCall,
} from "./wyvern-calls.js";
import type { DecodedFillEvent } from "./types.js";

/** Wyvern logs carry gross payment but omit currency/NFTs. Match a complete
 * interpreted order call to its successful receipt before creating execution
 * facts, retaining untracked NFT items in the shared unit-price denominator. */
export function decodeWyvernFills(
    tx: EnhancedTransaction,
    collections: Set<string>,
): DecodedFillEvent[] {
    const calls = decodeWyvernMatchCalls(tx.transaction);
    if (!calls.length) return [];
    const transfers = tx.receiptLogs.flatMap(decodeNftTransferLog);
    const usedCalls = new Set<WyvernMatchCall>();
    const fills: DecodedFillEvent[] = [];
    let previousMatch = -1;
    for (const log of [...tx.receiptLogs].sort(
        (a, b) => a.logIndex - b.logIndex,
    )) {
        const matched = decodeMatch(log);
        if (!matched) continue;
        const identified = calls.filter(
            (call) =>
                !usedCalls.has(call) &&
                call.protocolAddress === log.address.toLowerCase() &&
                call.maker === matched.maker &&
                call.taker === matched.taker &&
                call.metadata === matched.metadata,
        );
        const candidates = identified.filter((call) =>
            matchesTransfers(call, transfers, previousMatch, log.logIndex),
        );
        previousMatch = log.logIndex;
        if (!candidates.length || identified.some((call) => !call.nfts.length))
            continue;
        // Equivalent repeated calls have the same normalized facts. Different
        // payment/NFT shapes are ambiguous even when maker/taker coincide.
        const shape = (call: WyvernMatchCall) =>
            JSON.stringify([call.currency, call.orderSide, call.nfts]);
        if (new Set(candidates.map(shape)).size !== 1) continue;
        const call = candidates[0]!;
        usedCalls.add(call);
        const isAsk = call.orderSide === ORDER_SIDE.Sell;
        const nftSide = isAsk
            ? FILL_ITEM_SIDE.Offer
            : FILL_ITEM_SIDE.Consideration;
        const execution: FillExecution = {
            protocolAddress: call.protocolAddress,
            items: [
                ...call.nfts.map((nft, index) => ({
                    index,
                    side: nftSide,
                    itemType: nft.itemType,
                    contract: nft.contract,
                    identifier: nft.identifier,
                    amount: nft.amount,
                    recipient: nft.to,
                })),
                {
                    index: call.nfts.length,
                    side: isAsk
                        ? FILL_ITEM_SIDE.Consideration
                        : FILL_ITEM_SIDE.Offer,
                    itemType:
                        call.currency === zeroAddress
                            ? FILL_ITEM_TYPE.Native
                            : FILL_ITEM_TYPE.Erc20,
                    contract: call.currency,
                    identifier: "0",
                    amount: matched.price,
                    recipient: call.seller,
                },
            ],
        };
        call.nfts.forEach((nft, index) => {
            if (!collections.has(nft.contract)) return;
            fills.push({
                kind: FILL_KIND.Wyvern,
                orderId: isAsk ? matched.sellHash : matched.buyHash,
                orderSide: call.orderSide,
                maker: call.maker,
                taker: call.taker,
                contract: nft.contract,
                tokenId: nft.identifier,
                amount: nft.amount,
                price: matched.price,
                currency: call.currency,
                execution,
                executionItemIndex: index,
                blockNumber: tx.blockNumber,
                blockHash: tx.blockHash,
                txHash: tx.txHash,
                logIndex: log.logIndex,
            });
        });
    }
    return fills;
}

function decodeMatch(log: RpcLog) {
    if (!WYVERN_EXCHANGE_ADDRESSES.has(log.address.toLowerCase())) return null;
    try {
        const { args } = decodeEventLog({
            abi: WYVERN_EXCHANGE_ABI,
            eventName: WYVERN_EVENT_NAME.OrdersMatched,
            topics: log.topics as [Hex, ...Hex[]],
            data: log.data,
        });
        return {
            ...args,
            maker: args.maker.toLowerCase(),
            taker: args.taker.toLowerCase(),
            metadata: args.metadata.toLowerCase(),
            price: args.price.toString(),
        };
    } catch {
        return null;
    }
}

function matchesTransfers(
    call: WyvernMatchCall,
    transfers: readonly EnhancedEvent[],
    after: number,
    before: number,
): boolean {
    const used = new Set<EnhancedEvent>();
    return call.nfts.every((nft) => {
        const standard =
            nft.itemType === FILL_ITEM_TYPE.Erc721
                ? COLLECTION_STANDARD.Erc721
                : COLLECTION_STANDARD.Erc1155;
        const transfer = transfers.find(
            (event) =>
                !used.has(event) &&
                event.base.logIndex > after &&
                event.base.logIndex < before &&
                event.base.contract.toLowerCase() === nft.contract &&
                event.decoded.standard === standard &&
                event.decoded.tokenId === nft.identifier &&
                event.decoded.amount === nft.amount &&
                event.decoded.from.toLowerCase() === nft.from &&
                event.decoded.to.toLowerCase() === nft.to,
        );
        if (!transfer) return false;
        used.add(transfer);
        return true;
    });
}
