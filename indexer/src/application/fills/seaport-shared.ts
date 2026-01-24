import { zeroAddress } from "viem";
import type { Hex } from "../../ports/rpc.js";

export type SeaportItem = {
    itemType: number;
    token: Hex;
    identifierOrCriteria: bigint;
    startAmount: bigint;
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

// Ignore criteria-based items (itemType 4/5) until we add resolvers or logs-based matching.
export function findTrackedNftItem(
    items: readonly SeaportItem[],
    collections: Set<string>,
): { contract: string; tokenId: string; amount: string } | null {
    for (const item of items) {
        if (!isNftItem(item.itemType)) continue;
        if (item.itemType >= 4) continue;
        const token = item.token.toLowerCase();
        if (!collections.has(token)) continue;
        return {
            contract: token,
            tokenId: item.identifierOrCriteria.toString(),
            amount: item.startAmount.toString(),
        };
    }
    return null;
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
