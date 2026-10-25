import { asRecord, toBigInt } from "../offchain/normalizer-utils.js";
import { seaportIsNftItem, seaportItemType } from "./seaport.js";

/** Original NFT units, before applying any fill fraction or source remainder.
 * Zero means no matching NFTs; null means an item cannot be classified or an
 * NFT is incomplete/invalid. Dropping either would invent a smaller denominator. */
export function seaportNftQuantity(
    items: unknown,
    collectionAddress?: string,
): bigint | null {
    if (!Array.isArray(items)) return 0n;
    let quantity = 0n;
    for (const item of items) {
        if (!item || typeof item !== "object") return null;
        const itemType = seaportItemType(item.itemType ?? item.item_type);
        if (itemType === null) return null;
        if (!seaportIsNftItem(itemType)) continue;
        const token = asRecord(item).token;
        if (typeof token !== "string" || token.trim() === "") return null;
        if (
            collectionAddress &&
            token.toLowerCase() !== collectionAddress.toLowerCase()
        )
            continue;
        const amount = seaportItemAmount(item);
        if (amount === null || amount <= 0n) return null;
        quantity += amount;
    }
    return quantity;
}

/** Normalize the amount aliases used by signed protocol items and SDK objects. */
export function seaportItemAmount(item: unknown): bigint | null {
    const record = asRecord(item);
    const value = record.startAmount ?? record.start_amount ?? record.amount;
    try {
        const amount = toBigInt(value, "Seaport item amount");
        return amount >= 0n ? amount : null;
    } catch {
        return null;
    }
}
