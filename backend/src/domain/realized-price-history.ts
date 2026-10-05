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
    type PriceHistoryObservation,
    type PriceHistoryCounts,
    type RealizedPriceBucket,
    type RealizedSale,
} from "@artgod/shared/types/price-history";

import { ORDER_SIDE } from "@artgod/shared/market-data/orders";
import { compareUnitPrices } from "@artgod/shared/market-data/fills";

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

/** One pass over classified, chronologically ordered NFT observations. Exact arithmetic
 * belongs here; adapters own ordering, and renderers only map the result to pixels.
 * No bucket state is persisted. */
export function buildRealizedPriceHistory(
    source: Iterable<PriceHistoryObservation>,
    input: PriceHistoryRequest,
    end: number,
): PriceHistory {
    const bucket = priceHistoryBucket(input.bucket, input.range);
    const bucketSeconds = PRICE_HISTORY_BUCKET_SECONDS[bucket];
    const buckets: RealizedPriceBucket[] = [];
    const sales: RealizedSale[] = [];
    let current: RealizedPriceBucket | undefined;
    let turnover = 0n,
        volume = 0n;
    const counts: PriceHistoryCounts = {
        observations: 0,
        pricedObservations: 0,
        excludedObservations: 0,
        executions: 0,
        pricedNftQuantity: "0",
        excludedNftQuantity: "0",
        excludedByReason: {},
    };
    const executions = new Set<string>();
    let includedUnits = 0n,
        excludedUnits = 0n,
        previous = -1;
    let from = end,
        to = end;
    for (const observation of source) {
        if (counts.observations === PRICE_HISTORY_LIMITS.fills)
            throw new PriceHistoryInputError(
                "Choose a shorter price history range.",
            );
        if (observation.timestamp < previous)
            throw new Error("Price history reader returned unordered sales");
        previous = observation.timestamp;
        counts.observations++;
        executions.add(observation.executionId);
        if ("exclusionReason" in observation) {
            counts.excludedObservations++;
            excludedUnits += BigInt(observation.quantity);
            const reason = observation.exclusionReason;
            counts.excludedByReason[reason] =
                (counts.excludedByReason[reason] ?? 0) + 1;
            continue;
        }
        const sale = observation;
        counts.pricedObservations++;
        includedUnits += BigInt(sale.quantity);
        const timestamp = priceBucketStart(sale.timestamp, bucket);
        if (!sales.length) from = timestamp;
        to = timestamp + bucketSeconds;
        if ((to - from) / bucketSeconds > PRICE_HISTORY_LIMITS.buckets)
            throw new PriceHistoryInputError(
                "Choose a larger time bucket or a shorter range.",
            );
        const price = sale.unitPrice;
        if (!current || current.timestamp !== timestamp) {
            if (current) {
                current.turnoverWei = turnover.toString();
                current.volume = volume.toString();
            }
            turnover = BigInt(sale.attributedPriceWei);
            volume = BigInt(sale.quantity);
            current = {
                timestamp,
                open: price,
                high: price,
                low: price,
                close: price,
                volume: sale.quantity,
                turnoverWei: sale.attributedPriceWei,
            };
            buckets.push(current);
        } else {
            if (compareUnitPrices(price, current.high) > 0) {
                current.high = price;
            }
            if (compareUnitPrices(price, current.low) < 0) {
                current.low = price;
            }
            current.close = price;
            volume += BigInt(sale.quantity);
            turnover += BigInt(sale.attributedPriceWei);
        }
        sales.push(sale);
    }
    if (current) {
        current.turnoverWei = turnover.toString();
        current.volume = volume.toString();
    }
    counts.executions = executions.size;
    counts.pricedNftQuantity = includedUnits.toString();
    counts.excludedNftQuantity = excludedUnits.toString();
    return {
        unit: PRICE_HISTORY_UNIT,
        bucket,
        bucketSeconds,
        range: input.range,
        from,
        to,
        sales,
        buckets,
        counts,
    };
}
