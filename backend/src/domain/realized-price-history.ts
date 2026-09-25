import {
    PRICE_HISTORY_BUCKET_SECONDS,
    PRICE_HISTORY_LIMITS,
    PRICE_HISTORY_UNIT,
    priceBucketStart,
    type PriceHistory,
    type PriceHistoryRequest,
    type RealizedPriceBucket,
    type RealizedSale,
} from "@artgod/shared/types/price-history";
import { ReadModelBadRequestError } from "@artgod/shared/read-models/errors";
import { ORDER_SIDE } from "@artgod/shared/market-data/orders";

/** Maker is the seller of an ask and the buyer of an offer. Unknown sides
 * cannot establish either role, so never invent ownership links for them. */
export function realizedSaleParticipants(
    side: string | null,
    maker: string | null,
    taker: string | null,
): Pick<RealizedSale, "seller" | "buyer"> {
    if (side === ORDER_SIDE.Sell) return { seller: maker, buyer: taker };
    if (side === ORDER_SIDE.Buy) return { seller: taker, buyer: maker };
    return { seller: null, buyer: null };
}

export type PricedFill = RealizedSale & {
    blockNumber: number;
    logIndex: number;
};

/** Aggregate observed single-NFT prices, never interpolate or allocate a bundle. */
export function buildRealizedPriceHistory(
    fills: PricedFill[],
    input: PriceHistoryRequest,
    end: number,
): PriceHistory {
    fills.sort(
        (a, b) =>
            a.timestamp - b.timestamp ||
            a.blockNumber - b.blockNumber ||
            a.logIndex - b.logIndex ||
            a.id.localeCompare(b.id),
    );
    const bucketSeconds = PRICE_HISTORY_BUCKET_SECONDS[input.bucket];
    const from = fills.length
        ? priceBucketStart(fills[0]!.timestamp, input.bucket)
        : end;
    const to = fills.length
        ? priceBucketStart(fills.at(-1)!.timestamp, input.bucket) +
          bucketSeconds
        : end;
    if ((to - from) / bucketSeconds > PRICE_HISTORY_LIMITS.buckets) {
        throw new ReadModelBadRequestError(
            "Choose a larger time bucket or a shorter range.",
        );
    }
    const buckets: RealizedPriceBucket[] = [];
    const sales: RealizedSale[] = [];
    for (const fill of fills) {
        const timestamp = priceBucketStart(fill.timestamp, input.bucket);
        const price = BigInt(fill.priceWei);
        const previous = buckets.at(-1);
        if (!previous || previous.timestamp !== timestamp) {
            buckets.push({
                timestamp,
                openWei: fill.priceWei,
                highWei: fill.priceWei,
                lowWei: fill.priceWei,
                closeWei: fill.priceWei,
                volume: 1,
                turnoverWei: fill.priceWei,
            });
        } else {
            if (price > BigInt(previous.highWei))
                previous.highWei = fill.priceWei;
            if (price < BigInt(previous.lowWei))
                previous.lowWei = fill.priceWei;
            previous.closeWei = fill.priceWei;
            previous.volume++;
            previous.turnoverWei = (
                BigInt(previous.turnoverWei) + price
            ).toString();
        }
        const { blockNumber: _block, logIndex: _log, ...sale } = fill;
        sales.push(sale);
    }
    return {
        unit: PRICE_HISTORY_UNIT,
        bucket: input.bucket,
        bucketSeconds,
        range: input.range,
        from,
        to,
        sales,
        buckets,
    };
}
