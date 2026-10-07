import { zeroAddress } from "viem";
import {
    FILL_ITEM_SIDE,
    resolveFillNftSide,
} from "@artgod/shared/market-data/fills";
import { ORDER_SIDE } from "@artgod/shared/market-data/orders";
import type { Hex } from "../../ports/rpc.js";
import type { OrderSide } from "./types.js";

export type SeaportItem = {
    itemType: number;
    token: Hex;
    identifierOrCriteria: bigint;
    startAmount: bigint;
    endAmount?: bigint;
};

export function hasTrackedNft(
    items: readonly SeaportItem[],
    collections: Set<string>,
): boolean {
    for (const item of items) {
        if (!isNftItem(item.itemType)) continue;
        const token = item.token.toLowerCase();
        if (!collections.has(token)) continue;
        return true;
    }
    return false;
}

// Matched orders can repeat their offered NFTs as consideration to route them
// to a chosen recipient. Equal NFT legs are forwarding, not an NFT swap.
export function resolveSeaportOrderSide(
    offer: readonly SeaportItem[],
    consideration: readonly SeaportItem[],
    collections: Set<string>,
): OrderSide | null {
    if (
        !hasTrackedNft(offer, collections) &&
        !hasTrackedNft(consideration, collections)
    )
        return null;
    const items = [
        ...offer.map((item) => ({ ...item, side: FILL_ITEM_SIDE.Offer })),
        ...consideration.map((item) => ({
            ...item,
            side: FILL_ITEM_SIDE.Consideration,
        })),
    ].map((item) => ({
        side: item.side,
        itemType: item.itemType,
        contract: item.token,
        identifier: item.identifierOrCriteria.toString(),
        amount: item.startAmount.toString(),
        endAmount: item.endAmount?.toString(),
    }));
    const side = resolveFillNftSide(items);
    return side === null
        ? null
        : side === FILL_ITEM_SIDE.Offer
          ? ORDER_SIDE.Sell
          : ORDER_SIDE.Buy;
}

// Ignore criteria-based items (itemType 4/5) until we add resolvers or logs-based matching.
export function findTrackedNftItem(
    items: readonly SeaportItem[],
    collections: Set<string>,
): { contract: string; tokenId: string; amount: string } | null {
    return findTrackedNftItems(items, collections)[0] ?? null;
}

// Return every concrete tracked NFT item represented by a Seaport item list.
export function findTrackedNftItems(
    items: readonly SeaportItem[],
    collections: Set<string>,
): Array<{ contract: string; tokenId: string; amount: string }> {
    const out: Array<{ contract: string; tokenId: string; amount: string }> =
        [];
    for (const item of items) {
        if (!isNftItem(item.itemType)) continue;
        if (item.itemType >= 4) continue;
        const token = item.token.toLowerCase();
        if (!collections.has(token)) continue;
        out.push({
            contract: token,
            tokenId: item.identifierOrCriteria.toString(),
            amount: item.startAmount.toString(),
        });
    }
    return out;
}

export function isCurrencyItem(itemType: number): boolean {
    return itemType === 0 || itemType === 1;
}

export function sumAmounts(values: bigint[]): bigint {
    return values.reduce((acc, value) => acc + value, 0n);
}

export function normalizeCurrency(currency: string): string {
    const lowered = currency.toLowerCase();
    return lowered === zeroAddress ? zeroAddress : lowered;
}

function isNftItem(itemType: number): boolean {
    return itemType >= 2 && itemType <= 5;
}
