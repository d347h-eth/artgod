import {
    PRICE_HISTORY_BUCKET_SECONDS,
    PRICE_HISTORY_BUCKET,
    PRICE_HISTORY_RANGE,
    PRICE_HISTORY_LIMITS,
    PRICE_HISTORY_UNIT,
    REALIZED_SALE_ACTION,
    priceBucketStart,
    priceHistoryBucket,
    type PriceHistory,
    type PriceHistoryRequest,
    type RealizedPriceBucket,
    type RealizedSale,
} from "@artgod/shared/types/price-history";

import { ORDER_SIDE } from "@artgod/shared/market-data/orders";

export class PriceHistoryInputError extends Error {}

export function resolvePriceHistoryRequest(input: {
    bucket?: string;
    range?: string;
    tokenId?: string;
}): PriceHistoryRequest {
    const bucket = input.bucket ?? PRICE_HISTORY_BUCKET.Day;
    const range = input.range ?? PRICE_HISTORY_RANGE.All;
    if (
        !Object.values(PRICE_HISTORY_BUCKET).includes(
            bucket as PriceHistoryRequest["bucket"],
        ) ||
        !Object.values(PRICE_HISTORY_RANGE).includes(
            range as PriceHistoryRequest["range"],
        )
    )
        throw new PriceHistoryInputError(
            "Invalid price history range or bucket.",
        );
    if (
        input.tokenId !== undefined &&
        (!/^\d{1,78}$/.test(input.tokenId) ||
            BigInt(input.tokenId) >= 2n ** 256n)
    )
        throw new PriceHistoryInputError("Invalid token ID.");
    const validRange = range as PriceHistoryRequest["range"];
    return {
        bucket: priceHistoryBucket(
            bucket as PriceHistoryRequest["bucket"],
            validRange,
        ),
        range: validRange,
        tokenId:
            input.tokenId === undefined
                ? undefined
                : BigInt(input.tokenId).toString(),
    };
}

/** Maker sells an ask and buys an accepted offer. Preserve unknown order sides
 * without guessing the execution action or ownership roles. */
export function realizedSaleExecution(
    side: string | null,
    maker: string | null,
    taker: string | null,
): Pick<RealizedSale, "action" | "seller" | "buyer"> {
    if (side === ORDER_SIDE.Sell)
        return {
            action: REALIZED_SALE_ACTION.TakeAsk,
            seller: maker,
            buyer: taker,
        };
    if (side === ORDER_SIDE.Buy)
        return {
            action: REALIZED_SALE_ACTION.TakeOffer,
            seller: taker,
            buyer: maker,
        };
    return { action: null, seller: null, buyer: null };
}

/** One pass over already eligible, chronologically ordered sales. Exact arithmetic
 * belongs here; adapters own ordering, and renderers only map the result to pixels.
 * No bucket state is persisted. */
export function buildRealizedPriceHistory(
    source: Iterable<RealizedSale>,
    input: PriceHistoryRequest,
    end: number,
): PriceHistory {
    const bucket = priceHistoryBucket(input.bucket, input.range);
    const bucketSeconds = PRICE_HISTORY_BUCKET_SECONDS[bucket];
    const buckets: RealizedPriceBucket[] = [];
    const sales: RealizedSale[] = [];
    let current: RealizedPriceBucket | undefined;
    let high = 0n,
        low = 0n,
        turnover = 0n;
    let from = end,
        to = end;
    for (const sale of source) {
        if (sales.length === PRICE_HISTORY_LIMITS.fills)
            throw new PriceHistoryInputError(
                "Choose a shorter price history range.",
            );
        if (sales.length && sale.timestamp < sales[sales.length - 1]!.timestamp)
            throw new Error("Price history reader returned unordered sales");
        const timestamp = priceBucketStart(sale.timestamp, bucket);
        if (!sales.length) from = timestamp;
        to = timestamp + bucketSeconds;
        if ((to - from) / bucketSeconds > PRICE_HISTORY_LIMITS.buckets)
            throw new PriceHistoryInputError(
                "Choose a larger time bucket or a shorter range.",
            );
        const price = BigInt(sale.priceWei);
        if (!current || current.timestamp !== timestamp) {
            if (current) current.turnoverWei = turnover.toString();
            high = low = turnover = price;
            current = {
                timestamp,
                openWei: sale.priceWei,
                highWei: sale.priceWei,
                lowWei: sale.priceWei,
                closeWei: sale.priceWei,
                volume: 1,
                turnoverWei: sale.priceWei,
            };
            buckets.push(current);
        } else {
            if (price > high) {
                high = price;
                current.highWei = sale.priceWei;
            }
            if (price < low) {
                low = price;
                current.lowWei = sale.priceWei;
            }
            current.closeWei = sale.priceWei;
            current.volume++;
            turnover += price;
        }
        sales.push(sale);
    }
    if (current) current.turnoverWei = turnover.toString();
    return {
        unit: PRICE_HISTORY_UNIT,
        bucket,
        bucketSeconds,
        range: input.range,
        from,
        to,
        sales,
        buckets,
    };
}
