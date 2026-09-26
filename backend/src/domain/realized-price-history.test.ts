import { expect, it } from "vitest";
import {
    PRICE_HISTORY_BUCKET as BUCKET,
    PRICE_HISTORY_RANGE as RANGE,
    PRICE_HISTORY_CURRENCY_SYMBOL,
    type RealizedSale,
} from "@artgod/shared/types/price-history";
import {
    buildRealizedPriceHistory,
    resolvePriceHistoryRequest,
} from "./realized-price-history.js";

const sale = (timestamp: number, priceWei = "1"): RealizedSale => ({
    id: String(timestamp),
    timestamp,
    tokenId: "1",
    priceWei,
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
        openWei: sales[0].priceWei,
        closeWei: sales[1].priceWei,
        highWei: sales[1].priceWei,
        lowWei: sales[0].priceWei,
        turnoverWei: "18014398509481988",
        volume: 2,
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
