import { expect, it } from 'vitest';
import {
	PRICE_HISTORY_BUCKET,
	PRICE_HISTORY_RANGE,
	PRICE_HISTORY_LIMITS,
	PRICE_HISTORY_RANGE_DAYS,
	REALIZED_SALE_ACTION,
	priceBucketStart
} from '@artgod/shared/types/price-history';
import { GENERATED_SALES_DEFAULTS, generateSaleHistory } from './generated-sales';
import { saleBars } from './model';

const now = Date.UTC(2026, 8, 25, 12, 34, 56);
const request = { bucket: PRICE_HISTORY_BUCKET.Day, range: PRICE_HISTORY_RANGE.All };

it('reproduces a seeded wave with noise and changes it with another seed', () => {
	const first = generateSaleHistory(GENERATED_SALES_DEFAULTS, request, now);
	expect(generateSaleHistory(GENERATED_SALES_DEFAULTS, request, now)).toEqual(first);
	const other = generateSaleHistory({ ...GENERATED_SALES_DEFAULTS, seed: 2 }, request, now);
	expect(other.sales).not.toEqual(first.sales);
	expect(first.sales).toHaveLength(GENERATED_SALES_DEFAULTS.count);
	expect(new Set(first.sales.map((sale) => sale.id)).size).toBe(first.sales.length);
	expect(new Set(first.sales.map((sale) => sale.action))).toEqual(
		new Set(Object.values(REALIZED_SALE_ACTION))
	);
	const from = Math.floor(now / 1000) + 1 - 3 * 365 * 86400;
	first.sales.forEach((sale, i) => {
		expect(sale.timestamp).toBeGreaterThanOrEqual(i ? first.sales[i - 1].timestamp : from);
		expect(sale.timestamp).toBeLessThanOrEqual(now / 1000);
		expect(BigInt(sale.priceWei)).toBeGreaterThan(0n);
		expect(sale.txHash).toBe('');
		expect(sale.tokenId).toBe('');
		expect(sale.seller).toBeNull();
		expect(sale.buyer).toBeNull();
	});
});

it.each([PRICE_HISTORY_RANGE.Month, PRICE_HISTORY_RANGE.Quarter, PRICE_HISTORY_RANGE.Year])(
	'uses the selected %s range and ignores the all-range year setting',
	(range) => {
		const settings = { ...GENERATED_SALES_DEFAULTS, count: 100, years: NaN };
		const history = generateSaleHistory(settings, { ...request, range }, now);
		const from = Math.floor(now / 1000) + 1 - PRICE_HISTORY_RANGE_DAYS[range]! * 86400;
		expect(history.from).toBe(priceBucketStart(from, request.bucket));
		expect(
			history.sales.every((sale) => sale.timestamp >= from && sale.timestamp <= now / 1000)
		).toBe(true);
	}
);

it('rebuckets the same dots with exact OHLC and turnover, retaining empty gaps', () => {
	const settings = { ...GENERATED_SALES_DEFAULTS, count: 200 };
	const daily = generateSaleHistory(settings, request, now);
	const hourly = generateSaleHistory(
		settings,
		{ ...request, bucket: PRICE_HISTORY_BUCKET.Hour },
		now
	);
	expect(hourly.sales).toEqual(daily.sales);
	for (const history of [daily, hourly]) {
		expect(history.buckets.reduce((sum, bucket) => sum + bucket.volume, 0)).toBe(settings.count);
		expect(history.buckets.reduce((sum, bucket) => sum + BigInt(bucket.turnoverWei), 0n)).toBe(
			history.sales.reduce((sum, sale) => sum + BigInt(sale.priceWei), 0n)
		);
		for (const bucket of history.buckets) {
			const sales = history.sales.filter(
				(sale) => priceBucketStart(sale.timestamp, history.bucket) === bucket.timestamp
			);
			const prices = sales
				.map((sale) => BigInt(sale.priceWei))
				.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
			expect(bucket.openWei).toBe(sales[0].priceWei);
			expect(bucket.closeWei).toBe(sales.at(-1)!.priceWei);
			expect(bucket.lowWei).toBe(String(prices[0]));
			expect(bucket.highWei).toBe(String(prices.at(-1)));
		}
		const bars = saleBars(history);
		expect(bars.some((bar) => !bar.populated && Number.isNaN(bar.close))).toBe(true);
		expect(bars.flatMap((bar) => bar.sales)).toEqual(history.sales);
	}
});

it('allows the fill cap and rejects excess dots or timeline buckets before allocation', () => {
	const history = generateSaleHistory(
		{ ...GENERATED_SALES_DEFAULTS, count: PRICE_HISTORY_LIMITS.fills },
		request,
		now
	);
	expect(history.sales).toHaveLength(PRICE_HISTORY_LIMITS.fills);
	for (const count of [0, 1.5, NaN, Infinity, PRICE_HISTORY_LIMITS.fills + 1]) {
		expect(() => generateSaleHistory({ ...GENERATED_SALES_DEFAULTS, count }, request, now)).toThrow(
			/dot count/
		);
	}
	expect(() =>
		generateSaleHistory({ ...GENERATED_SALES_DEFAULTS, seed: -1 }, request, now)
	).toThrow(/seed/);
	expect(() =>
		generateSaleHistory({ ...GENERATED_SALES_DEFAULTS, years: NaN }, request, now)
	).toThrow(/year count/);
	expect(() =>
		generateSaleHistory(
			{ ...GENERATED_SALES_DEFAULTS, years: 4 },
			{ ...request, bucket: PRICE_HISTORY_BUCKET.Hour },
			now
		)
	).toThrow('Choose a larger time bucket or a shorter range.');
});
