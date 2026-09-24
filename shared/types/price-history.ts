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
export const PRICE_HISTORY_QUERY = {
    Bucket: "bucket",
    Range: "range",
    TokenId: "token_id",
} as const;
export const PRICE_HISTORY_ROUTE = COLLECTION_API_ROUTE_TEMPLATE.PriceHistory;
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

export type PriceHistoryRequest = {
    bucket: PriceHistoryBucket;
    range: PriceHistoryRange;
    tokenId?: string;
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

export function buildPriceHistoryPath(
    chainRef: string,
    collectionRef: string,
    input: PriceHistoryRequest,
): string {
    const query = new URLSearchParams({
        [PRICE_HISTORY_QUERY.Bucket]: input.bucket,
        [PRICE_HISTORY_QUERY.Range]: input.range,
    });
    if (input.tokenId !== undefined)
        query.set(PRICE_HISTORY_QUERY.TokenId, input.tokenId);
    return (
        PRICE_HISTORY_ROUTE.replace(
            ":chain_ref",
            encodeURIComponent(chainRef),
        ).replace(":collection_ref", encodeURIComponent(collectionRef)) +
        "?" +
        query
    );
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
import { COLLECTION_API_ROUTE_TEMPLATE } from "../http/collection-routes.js";
