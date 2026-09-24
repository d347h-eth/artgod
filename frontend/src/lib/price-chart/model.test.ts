import { expect, it } from 'vitest';
import type { Indicator, KLineData } from 'klinecharts';
import {
	PRICE_HISTORY_BUCKET,
	PRICE_HISTORY_RANGE,
	PRICE_HISTORY_UNIT,
	PRICE_HISTORY_CURRENCY_SYMBOL,
	type PriceHistory
} from '@artgod/shared/types/price-history';
import {
	ethText,
	saleBars,
	standardMacd,
	withSaleGaps,
	validIndicatorParameters,
	PRICE_INDICATOR
} from './model';

it('keeps gaps and every same-time sale without fabricating a close', () => {
	const history: PriceHistory = {
		unit: PRICE_HISTORY_UNIT,
		bucket: PRICE_HISTORY_BUCKET.Hour,
		bucketSeconds: 3600,
		range: PRICE_HISTORY_RANGE.All,
		from: 0,
		to: 10800,
		buckets: [0, 7200].map((timestamp) => ({
			timestamp,
			openWei: '1000000000000000001',
			highWei: '2000000000000000000',
			lowWei: '1000000000000000001',
			closeWei: '2000000000000000000',
			volume: 2,
			turnoverWei: '3000000000000000001'
		})),
		sales: [0, 0, 7200, 7250].map((timestamp, i) => ({
			id: String(i),
			timestamp,
			tokenId: String(i),
			priceWei: '1000000000000000001',
			currencyAddress: '0x0000000000000000000000000000000000000000',
			currencySymbol: PRICE_HISTORY_CURRENCY_SYMBOL.Eth,
			txHash: 'tx' + i
		}))
	};
	const bars = saleBars(history);
	expect(bars.map((bar) => bar.timestamp)).toEqual([0, 3600000, 7200000]);
	expect(bars.map((bar) => bar.volume)).toEqual([2, 0, 2]);
	expect(bars[1].close).toBeNaN();
	expect(bars[0].sales.map((sale) => sale.id)).toEqual(['0', '1']);
	expect(bars.flatMap((bar) => bar.sales)).toEqual(history.sales);
	expect(ethText(history.sales[0].priceWei)).toBe('1.000000000000000001');
});

it('calculates on populated buckets and restores blank indicator results', async () => {
	const bars: KLineData[] = [1, NaN, 3, 5].map((close, index) => ({
		timestamp: index * 3600000,
		open: close,
		high: close,
		low: close,
		close,
		populated: Number.isFinite(close)
	}));
	const result = await withSaleGaps((data) =>
		data.map((bar, i) => (i === 0 ? {} : { mean: (bar.close + data[i - 1].close) / 2 }))
	)(bars, {} as Indicator);
	expect(result).toEqual([{}, {}, { mean: 2 }, { mean: 4 }]);
	const macd = await standardMacd(() => [{ dif: 4, dea: 3, macd: 2 }])([], {} as Indicator);
	expect(macd).toEqual([{ dif: 4, dea: 3, macd: 1 }]);
	expect(validIndicatorParameters(PRICE_INDICATOR.Macd, [26, 12, 9])).toBe(false);
	expect(validIndicatorParameters(PRICE_INDICATOR.Sma, [20.5])).toBe(false);
});
