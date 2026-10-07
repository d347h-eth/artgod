import { expect, it } from "vitest";
import { pricedSaleFixture } from "@artgod/shared/testing/price-history";
import {
    PRICE_HISTORY_BUCKET as BUCKET,
    PRICE_HISTORY_RANGE as RANGE,
    PRICE_HISTORY_CURRENCY_SYMBOL,
    PRICE_HISTORY_LIMITS,
    type PriceHistoryObservation,
    type RealizedSale,
} from "@artgod/shared/types/price-history";
import {
    FILL_PRICE_EXCLUSION,
    FILL_PRICE_BASIS,
} from "@artgod/shared/market-data/fills";
import {
    buildRealizedPriceHistory,
    resolvePriceHistoryRequest,
} from "./realized-price-history.js";

const sale = (timestamp: number, priceWei = "1"): RealizedSale => ({
    id: String(timestamp),
    timestamp,
    tokenId: "1",
    ...pricedSaleFixture(priceWei, String(timestamp)),
    currencyAddress: "0x" + "0".repeat(40),
    currencySymbol: PRICE_HISTORY_CURRENCY_SYMBOL.Eth,
    action: null,
    seller: null,
    buyer: null,
    txHash: "tx",
});

it("normalizes all-history buckets but preserves short-range choices and canonical token IDs", () => {
    expect(
        resolvePriceHistoryRequest({ bucket: BUCKET.Week, range: RANGE.All }),
    ).toMatchObject({ bucket: BUCKET.Day, range: RANGE.All });
    expect(
        resolvePriceHistoryRequest({
            bucket: BUCKET.Hour,
            range: RANGE.Year,
            tokenId: "0001",
        }),
    ).toEqual({ bucket: BUCKET.Hour, range: RANGE.Year, tokenId: "1" });
});

it("consumes an ordered iterator once and leaves exact input sales unchanged", () => {
    const sales = Object.freeze([
        Object.freeze(sale(86400, "9007199254740993")),
        Object.freeze(sale(86401, "9007199254740995")),
        Object.freeze(sale(3 * 86400, "0")),
    ]);
    const iterator = sales.values();
    const result = buildRealizedPriceHistory(
        iterator,
        { bucket: BUCKET.Day, range: RANGE.All },
        4 * 86400,
    );
    expect(iterator.next().done).toBe(true);
    expect(result.sales).toEqual(sales);
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets[0]).toMatchObject({
        open: sales[0].unitPrice,
        close: sales[1].unitPrice,
        high: sales[1].unitPrice,
        low: sales[0].unitPrice,
        turnoverWei: "18014398509481988",
        volume: "2",
    });
    expect(result.to - result.from).toBe(3 * 86400);
});

it("rejects an adapter ordering violation and an oversized bucket grid", () => {
    const input = { bucket: BUCKET.Hour, range: RANGE.Year };
    expect(() =>
        buildRealizedPriceHistory([sale(2), sale(1)], input, 3),
    ).toThrow("unordered sales");
    expect(() =>
        buildRealizedPriceHistory(
            [sale(0), sale(30_000 * 3600)],
            input,
            30_001 * 3600,
        ),
    ).toThrow("larger time bucket");
});

it("compares exact rational prices and sums quantities without unsafe-number rounding", () => {
    const quantity = "9007199254740993";
    const denominator = (3n * BigInt(quantity)).toString();
    const first = {
        ...sale(86400),
        unitPrice: { numeratorWei: quantity, denominator },
        quantity,
        executionTotalWei: quantity,
        executionNftQuantity: denominator,
        priceBasis: FILL_PRICE_BASIS.BundleAverage,
        attributedPriceWei: quantity,
    };
    const second = {
        ...sale(86401),
        unitPrice: { numeratorWei: "1", denominator: "2" },
        quantity: "2",
        executionNftQuantity: "2",
        attributedPriceWei: "1",
    };
    const result = buildRealizedPriceHistory(
        [first, second],
        { bucket: BUCKET.Day, range: RANGE.All },
        100000,
    );
    expect(result.buckets[0]).toEqual({
        timestamp: 86400,
        open: first.unitPrice,
        high: second.unitPrice,
        low: first.unitPrice,
        close: second.unitPrice,
        volume: "9007199254740995",
        turnoverWei: "9007199254740994",
    });
    expect(result.counts.pricedNftQuantity).toBe("9007199254740995");
});

it("counts excluded observations toward the limit rather than silently skipping them", () => {
    const omitted: PriceHistoryObservation = {
        id: "excluded",
        executionId: "execution",
        timestamp: 1,
        tokenId: "1",
        quantity: "2",
        exclusionReason: FILL_PRICE_EXCLUSION.Swap,
    };
    const input = { bucket: BUCKET.Day, range: RANGE.All };
    const history = buildRealizedPriceHistory([omitted], input, 10);
    expect(history.sales).toEqual([]);
    expect(history.counts).toMatchObject({
        observations: 1,
        excludedObservations: 1,
        excludedNftQuantity: "2",
        executions: 1,
    });
    function* overflow() {
        for (let i = 0; i <= PRICE_HISTORY_LIMITS.fills; i++) yield omitted;
    }
    expect(() => buildRealizedPriceHistory(overflow(), input, 10)).toThrow(
        "shorter price history range",
    );
});
