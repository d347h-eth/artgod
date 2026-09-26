import type {
    ChainRecord,
    CollectionListItem,
    CollectionMediaState,
    TraitFacet,
    TraitFilter,
    TraitRangeFilter,
} from "./browse.js";

export type CollectionPriceChartContext = {
    chain: ChainRecord;
    collection: CollectionListItem;
    media: CollectionMediaState;
    traits: {
        selected: TraitFilter[];
        selectedRanges: TraitRangeFilter[];
        facets: TraitFacet[];
    };
};

export const PRICE_HISTORY_BUCKET = {
    Hour: "1h",
    FourHours: "4h",
    Day: "1d",
    Week: "1w",
} as const;
export type PriceHistoryBucket =
    (typeof PRICE_HISTORY_BUCKET)[keyof typeof PRICE_HISTORY_BUCKET];
export const PRICE_HISTORY_BUCKET_SECONDS: Record<PriceHistoryBucket, number> =
    {
        "1h": 3600,
        "4h": 14400,
        "1d": 86400,
        "1w": 604800,
    };
export const PRICE_HISTORY_RANGE = {
    Month: "30d",
    Quarter: "90d",
    Year: "1y",
    All: "all",
} as const;
export type PriceHistoryRange =
    (typeof PRICE_HISTORY_RANGE)[keyof typeof PRICE_HISTORY_RANGE];
export const PRICE_HISTORY_RANGE_DAYS: Record<
    PriceHistoryRange,
    number | null
> = {
    [PRICE_HISTORY_RANGE.Month]: 30,
    [PRICE_HISTORY_RANGE.Quarter]: 90,
    [PRICE_HISTORY_RANGE.Year]: 365,
    [PRICE_HISTORY_RANGE.All]: null,
};
export const PRICE_HISTORY_LIMITS = {
    fills: 100_000,
    buckets: 30_000,
} as const;
export const PRICE_HISTORY_CURRENCY_SYMBOL = {
    Eth: "ETH",
    Weth: "WETH",
    Beth: "BETH",
} as const;
export type PriceHistoryCurrencySymbol =
    (typeof PRICE_HISTORY_CURRENCY_SYMBOL)[keyof typeof PRICE_HISTORY_CURRENCY_SYMBOL];
export const PRICE_HISTORY_UNIT = PRICE_HISTORY_CURRENCY_SYMBOL.Eth;

export const REALIZED_SALE_ACTION = {
    TakeAsk: "take-ask",
    TakeOffer: "take-offer",
} as const;
export type RealizedSaleAction =
    (typeof REALIZED_SALE_ACTION)[keyof typeof REALIZED_SALE_ACTION];

export type PriceHistoryRequest = {
    bucket: PriceHistoryBucket;
    range: PriceHistoryRange;
    tokenId?: string;
    traits?: TraitFilter[];
    traitRanges?: TraitRangeFilter[];
};
// Exact base-unit prices survive transport; only the renderer converts to floats.
// Sales retain their execution currency; aggregate prices use the 1:1 ETH unit.
export type RealizedSale = {
    id: string;
    timestamp: number;
    tokenId: string;
    priceWei: string;
    currencyAddress: string;
    currencySymbol: PriceHistoryCurrencySymbol;
    // The executed order side, not an inference from currency or price movement.
    action: RealizedSaleAction | null;
    seller: string | null;
    buyer: string | null;
    txHash: string;
};
export type RealizedPriceBucket = {
    timestamp: number;
    openWei: string;
    highWei: string;
    lowWei: string;
    closeWei: string;
    volume: number;
    turnoverWei: string;
};
export type PriceHistory = {
    unit: typeof PRICE_HISTORY_UNIT;
    bucket: PriceHistoryBucket;
    bucketSeconds: number;
    range: PriceHistoryRange;
    from: number;
    to: number;
    sales: RealizedSale[];
    // Empty buckets are absent on the wire; the renderer expands the UTC grid.
    buckets: RealizedPriceBucket[];
};

/** Bound long histories without pagination. This rule also covers future ranges. */
export function priceHistoryBuckets(
    range: PriceHistoryRange,
): readonly PriceHistoryBucket[] {
    const days = PRICE_HISTORY_RANGE_DAYS[range];
    return days === null || days > 2 * 365
        ? [PRICE_HISTORY_BUCKET.Day]
        : Object.values(PRICE_HISTORY_BUCKET);
}

export function priceHistoryBucket(
    bucket: PriceHistoryBucket,
    range: PriceHistoryRange,
): PriceHistoryBucket {
    return priceHistoryBuckets(range).includes(bucket)
        ? bucket
        : PRICE_HISTORY_BUCKET.Day;
}

// Weekly buckets start Monday 00:00 UTC, all others at UTC epoch multiples.
export function priceBucketStart(
    timestamp: number,
    bucket: PriceHistoryBucket,
): number {
    const seconds = PRICE_HISTORY_BUCKET_SECONDS[bucket];
    const origin = bucket === PRICE_HISTORY_BUCKET.Week ? 4 * 86400 : 0;
    return Math.floor((timestamp - origin) / seconds) * seconds + origin;
}
