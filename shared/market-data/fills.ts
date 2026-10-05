// Protocol identity and execution currency shared by decoding and fill readers.
export const FILL_KIND = { Seaport: "seaport", BlurV2: "blur-v2" } as const;
export const BLUR_BETH_ADDRESS = "0x0000000000a39bb272e79075ade125fd351887ac";

export const FILL_ITEM_SIDE = {
    Offer: "offer",
    Consideration: "consideration",
} as const;
export type FillItemSide = (typeof FILL_ITEM_SIDE)[keyof typeof FILL_ITEM_SIDE];
// Seaport's concrete item vocabulary; Blur execution facts map to the same model.
export const FILL_ITEM_TYPE = {
    Native: 0,
    Erc20: 1,
    Erc721: 2,
    Erc1155: 3,
    Criteria721: 4,
    Criteria1155: 5,
} as const;
export type FillExecutionItem = {
    index: number;
    side: FillItemSide;
    itemType: number;
    contract: string;
    identifier: string;
    amount: string;
    recipient: string | null;
};
export type FillExecution = {
    protocolAddress: string;
    items: readonly FillExecutionItem[];
};
export const FILL_PRICE_EXCLUSION = {
    Swap: "nft-swap",
    MixedPayment: "mixed-payment",
    NoPayment: "no-payment",
    UnsupportedItems: "unsupported-items",
    UnsupportedCurrency: "unsupported-currency",
} as const;
export type FillPriceExclusion =
    (typeof FILL_PRICE_EXCLUSION)[keyof typeof FILL_PRICE_EXCLUSION];
export const FILL_PRICE_BASIS = {
    Unit: "unit",
    BundleAverage: "bundle-average",
} as const;
export type FillPriceBasis =
    (typeof FILL_PRICE_BASIS)[keyof typeof FILL_PRICE_BASIS];
export type ExactUnitPrice = { numeratorWei: string; denominator: string };
export type FillPayment = {
    exclusion: FillPriceExclusion | null;
    totalPrice: string | null;
    currency: string | null;
    nftQuantity: string;
};

export function fillExecutionIdentity(
    chainId: number,
    kind: string,
    txHash: string,
    logIndex: number,
): string {
    return `${chainId}:${kind}:${txHash.toLowerCase()}:${logIndex}`;
}

type FillNftSideItem = Pick<
    FillExecutionItem,
    "side" | "itemType" | "contract" | "identifier" | "amount"
> & {
    // Validated orders declare both quantity endpoints; executions are fixed.
    endAmount?: string;
};

/** Resolve the sold NFT leg from complete protocol items before tracking filters.
 * Matched orders may forward the same concrete NFT multiset on the other leg.
 * Currency on exactly one side establishes which leg carries the sold units. */
export function resolveFillNftSide(
    items: readonly FillNftSideItem[],
): FillItemSide | null {
    const offered = items.filter(
        (item) => isFillNftItem(item) && item.side === FILL_ITEM_SIDE.Offer,
    );
    const considered = items.filter(
        (item) =>
            isFillNftItem(item) && item.side === FILL_ITEM_SIDE.Consideration,
    );
    if (!offered.length && !considered.length) return null;
    if (!considered.length) return FILL_ITEM_SIDE.Offer;
    if (!offered.length) return FILL_ITEM_SIDE.Consideration;
    if (!haveSameConcreteNfts(offered, considered)) return null;

    const paymentSides = new Set(
        items
            .filter(
                (item) =>
                    item.itemType === FILL_ITEM_TYPE.Native ||
                    item.itemType === FILL_ITEM_TYPE.Erc20,
            )
            .map((item) => item.side),
    );
    if (paymentSides.size !== 1) return null;
    return paymentSides.has(FILL_ITEM_SIDE.Offer)
        ? FILL_ITEM_SIDE.Consideration
        : FILL_ITEM_SIDE.Offer;
}

function haveSameConcreteNfts(
    offered: readonly FillNftSideItem[],
    considered: readonly FillNftSideItem[],
): boolean {
    if (
        offered.length !== considered.length ||
        [...offered, ...considered].some(
            (item) => item.itemType > FILL_ITEM_TYPE.Erc1155,
        )
    )
        return false;

    const identity = (item: FillNftSideItem) =>
        `${item.itemType}:${item.contract.toLowerCase()}:${unsignedAmount(item.identifier)}:${unsignedAmount(item.amount)}:${unsignedAmount(item.endAmount ?? item.amount)}`;
    const unmatched = new Map<string, number>();
    for (const item of considered) {
        const key = identity(item);
        unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
    }
    for (const item of offered) {
        const key = identity(item);
        const count = unmatched.get(key) ?? 0;
        if (!count) return false;
        unmatched.set(key, count - 1);
    }
    return true;
}

/** Derive the monetary shape once at ingestion, from all protocol items. No tracking
 * or chart scope participates. A bid's offer is its gross payment; same-currency
 * consideration can distribute that payment alongside its NFTs (fees/proceeds).
 * Those return legs must never be added to the gross offered amount again. */
export function summarizeFillPayment(
    items: readonly FillExecutionItem[],
): FillPayment {
    const nftSide = resolveFillNftSide(items);
    const nfts = items.filter(
        (item) =>
            isFillNftItem(item) && (nftSide === null || item.side === nftSide),
    );
    const nftQuantity = nfts
        .reduce((n, item) => n + positiveQuantity(item.amount), 0n)
        .toString();
    const excluded = (exclusion: FillPriceExclusion): FillPayment => ({
        exclusion,
        nftQuantity,
        totalPrice: null,
        currency: null,
    });
    if (
        items.some(
            (i) =>
                i.itemType < FILL_ITEM_TYPE.Native ||
                i.itemType > FILL_ITEM_TYPE.Erc1155,
        )
    )
        return excluded(FILL_PRICE_EXCLUSION.UnsupportedItems);
    if (nftSide === null)
        return excluded(
            nfts.length
                ? FILL_PRICE_EXCLUSION.Swap
                : FILL_PRICE_EXCLUSION.UnsupportedItems,
        );
    const money = items.filter((i) => !isFillNftItem(i));
    if (!money.length) return excluded(FILL_PRICE_EXCLUSION.NoPayment);
    const currencies = new Set(money.map((i) => i.contract.toLowerCase()));
    if (currencies.size !== 1)
        return excluded(FILL_PRICE_EXCLUSION.MixedPayment);
    const payments = money.filter((i) => i.side !== nftSide);
    if (!payments.length) return excluded(FILL_PRICE_EXCLUSION.NoPayment);
    const total = payments.reduce((n, i) => n + unsignedAmount(i.amount), 0n);
    const returns = money.filter((i) => i.side === nftSide);
    if (
        returns.length &&
        (nftSide === FILL_ITEM_SIDE.Offer ||
            returns.reduce((n, i) => n + unsignedAmount(i.amount), 0n) > total)
    )
        return excluded(FILL_PRICE_EXCLUSION.MixedPayment);
    return {
        exclusion: null,
        nftQuantity,
        currency: money[0]!.contract.toLowerCase(),
        totalPrice: total.toString(),
    };
}

export function isFillNftItem(
    item: Pick<FillExecutionItem, "itemType">,
): boolean {
    return (
        item.itemType >= FILL_ITEM_TYPE.Erc721 &&
        item.itemType <= FILL_ITEM_TYPE.Criteria1155
    );
}

/** Retain every raw item, but prefix sold NFT units only: forwarding legs must
 * not double the unit-price denominator or consume another remainder share. */
export function prepareFillExecution(execution: FillExecution) {
    let offset = 0n;
    const nftSide = resolveFillNftSide(execution.items);
    const items = execution.items.map((item, index) => {
        if (
            item.index !== index ||
            !Object.values(FILL_ITEM_SIDE).includes(item.side)
        )
            throw new Error("Invalid fill execution item identity");
        unsignedAmount(item.identifier);
        unsignedAmount(item.amount);
        const unitOffset = offset.toString();
        if (isFillNftItem(item) && (nftSide === null || item.side === nftSide))
            offset += positiveQuantity(item.amount);
        return { ...item, unitOffset };
    });
    return { payment: summarizeFillPayment(execution.items), items };
}

export function fillAttributionItem(
    execution: FillExecution,
    index: number,
    attribution: { contract: string; tokenId: string; amount?: string },
): FillExecutionItem {
    const item = execution.items[index];
    const nftSide = resolveFillNftSide(execution.items);
    if (
        !item ||
        !isFillNftItem(item) ||
        item.itemType > FILL_ITEM_TYPE.Erc1155 ||
        (nftSide !== null && item.side !== nftSide) ||
        item.index !== index ||
        item.contract !== attribution.contract ||
        item.identifier !== attribution.tokenId ||
        item.amount !== attribution.amount
    )
        throw new Error("Fill attribution contradicts execution item");
    return item;
}

export function unsignedAmount(value: string): bigint {
    if (!/^\d{1,78}$/.test(value) || BigInt(value) >= 2n ** 256n)
        throw new Error("Invalid fill amount");
    return BigInt(value);
}
function positiveQuantity(value: string): bigint {
    const quantity = unsignedAmount(value);
    if (!quantity) throw new Error("Invalid fill quantity");
    return quantity;
}

/** Exact average plus whole-wei attribution. Earlier NFT units receive the
 * remainder. The offset uses ALL execution legs, so filters never reassign it. */
export function allocateFillPayment(
    totalPrice: string,
    nftQuantity: string,
    quantity: string,
    unitOffset: string,
): {
    unitPrice: ExactUnitPrice;
    attributedPrice: string;
    priceBasis: FillPriceBasis;
} {
    const total = BigInt(totalPrice),
        count = BigInt(nftQuantity),
        units = BigInt(quantity),
        offset = BigInt(unitOffset);
    if (
        total < 0n ||
        count <= 0n ||
        units <= 0n ||
        offset < 0n ||
        offset + units > count
    )
        throw new Error("Invalid fill allocation");
    const remainder = total % count;
    const extra =
        remainder <= offset
            ? 0n
            : remainder >= offset + units
              ? units
              : remainder - offset;
    return {
        unitPrice: { numeratorWei: totalPrice, denominator: nftQuantity },
        attributedPrice: (units * (total / count) + extra).toString(),
        priceBasis:
            count === units
                ? FILL_PRICE_BASIS.Unit
                : FILL_PRICE_BASIS.BundleAverage,
    };
}

export function compareUnitPrices(
    a: ExactUnitPrice,
    b: ExactUnitPrice,
): number {
    const difference =
        BigInt(a.numeratorWei) * BigInt(b.denominator) -
        BigInt(b.numeratorWei) * BigInt(a.denominator);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
