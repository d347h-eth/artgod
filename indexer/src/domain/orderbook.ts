import { zeroAddress } from "viem";
import type { OrderbookVenue } from "@artgod/shared/market-data/orders";
import type { OrderUpsertPayload } from "./order-jobs.js";
import type { SeaportOrderData } from "./orders.js";

export const BOOK_VIEW = { Public: "public", Stream: "stream" } as const;
export const BOOK_CHANGE = {
    Addition: "addition",
    Change: "change",
    Removal: "removal",
} as const;
export type BookMarket = {
    chainId: number;
    venue: OrderbookVenue;
    reference: string;
    contract: string;
};
export type BookFeed = BookMarket & { view: string };
export type BookCoverage =
    | { kind: "snapshot" | "window" | "sighting" }
    | { kind: "sequence"; position: number; baseline?: boolean };
export type BookOrder = Omit<
    OrderUpsertPayload,
    | "chainId"
    | "collectionId"
    | "observedAt"
    | "validateAfterUpsert"
    | "rawSourceKind"
    | "rawPayload"
    | "source"
>;
export type BookObservation = {
    nativeId: string;
    /** Registry identity for the venue that actually published this order. */
    placement: BookMarket;
    placementOrderId?: string;
    settlementId: string | null;
    status: string;
    fillable: boolean;
    audience: string | null;
    sourceTime: number | null;
    order: BookOrder | null;
    fees: string | null;
    proceeds: string | null;
};
export function settlementIdentity(
    chainId: number,
    protocol: string,
    hash: string,
): string {
    return [
        "seaport",
        chainId,
        protocol.toLowerCase(),
        hash.toLowerCase(),
    ].join(":");
}

/** Only fixed, same-currency consideration can establish exact seller proceeds.
 * The signed gross is the funding requirement. An executable unit must divide
 * every transfer exactly for a partial Seaport fill. */
export function cashBidAmounts(data: SeaportOrderData) {
    const nft = data.consideration.filter((item) =>
        ["2", "3", "4", "5"].includes(item.itemType),
    );
    const currency = data.offer[0]?.token;
    if (!currency || currency === zeroAddress || nft.length !== 1) return null;
    if (
        data.offer.some(
            (item) =>
                item.itemType !== "1" ||
                item.token !== currency ||
                item.startAmount !== item.endAmount,
        )
    )
        return null;
    const target = nft[0]!;
    const quantity = BigInt(target.startAmount);
    if (quantity < 1n || target.endAmount !== target.startAmount) return null;
    const payments = data.consideration.filter((item) => item !== target);
    if (
        payments.some(
            (item) =>
                item.itemType !== "1" ||
                item.token !== currency ||
                item.startAmount !== item.endAmount,
        )
    )
        return null;
    const gross = data.offer.reduce(
        (sum, item) => sum + BigInt(item.startAmount),
        0n,
    );
    const fees = payments.reduce(
        (sum, item) => sum + BigInt(item.startAmount),
        0n,
    );
    if (
        gross <= fees ||
        [...payments, ...data.offer].some(
            (item) => BigInt(item.startAmount) % quantity !== 0n,
        )
    )
        return null;
    return {
        target,
        currency,
        quantity,
        gross,
        fees,
        proceeds: (gross - fees) / quantity,
    };
}

export const VVV_READ_JOB = "orderbook.vvv.read";
export const VVV_READ_INTERVAL_MS = 15 * 60_000;
export type BoundMarketJob = {
    feedId: number;
    bindingRevision: number;
    generation: number;
};
