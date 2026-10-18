import { asRecord, toBigInt } from "../offchain/normalizer-utils.js";
import { seaportIsNftItem } from "./seaport.js";

/** Original NFT units, before applying any protocol fill fraction or source remainder. */
export function seaportNftQuantity(
    items: unknown,
    collectionAddress?: string,
): bigint {
    if (!Array.isArray(items)) return 0n;
    let quantity = 0n;
    for (const item of items) {
        if (!item || typeof item !== "object") continue;
        if (!seaportIsNftItem(item.itemType ?? item.item_type)) continue;
        if (
            collectionAddress &&
            String(item.token).toLowerCase() !== collectionAddress.toLowerCase()
        )
            continue;
        const amount = seaportItemAmount(item);
        if (amount !== null) quantity += amount;
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
