import { expect, it } from 'vitest';
import { pricedSaleFixture } from '@artgod/shared/testing/price-history';
import { FILL_PRICE_BASIS } from '@artgod/shared/market-data/fills';
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
	unitPriceText,
	unitPriceValue,
	salePriceTitle,
	salePriceText,
	saleBars,
	saleVolumeTooltip,
	standardMacd,
	withSaleGaps,
	validIndicatorParameters,
	PRICE_INDICATOR
} from './model';

it.each([
	['0', '0'],
	['1', '0'],
	['223000000000000000', '0.223'],
	['223499999999999999', '0.223'],
	['223500000000000000', '0.224'],
	['999500000000000000', '1'],
	['1200000000000000000', '1.2'],
	['9007199254740993223500000000000000', '9007199254740993.224']
])('rounds sale rows to at most three decimals: %s', (wei, expected) => {
	expect(salePriceText({ numeratorWei: wei, denominator: '1' })).toBe(expected);
});

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
			open: { numeratorWei: '1000000000000000001', denominator: '1' },
			high: { numeratorWei: '2000000000000000000', denominator: '1' },
			low: { numeratorWei: '1000000000000000001', denominator: '1' },
			close: { numeratorWei: '2000000000000000000', denominator: '1' },
			volume: '2',
			turnoverWei: '3000000000000000001'
		})),
		sales: [0, 0, 7200, 7250].map((timestamp, i) => ({
			id: String(i),
			timestamp,
			tokenId: String(i),
			...pricedSaleFixture('1000000000000000001', String(i)),
			action: null,
			currencyAddress: '0x0000000000000000000000000000000000000000',
			currencySymbol: PRICE_HISTORY_CURRENCY_SYMBOL.Eth,
			seller: null,
			buyer: null,
			txHash: 'tx' + i
		})),
		counts: {
			observations: 4,
			pricedObservations: 4,
			excludedObservations: 0,
			executions: 4,
			pricedNftQuantity: '4',
			excludedNftQuantity: '0',
			excludedByReason: {}
		}
	};
	const bars = saleBars(history);
	expect(bars.map((bar) => bar.timestamp)).toEqual([0, 3600000, 7200000]);
	expect(bars.map((bar) => bar.volume)).toEqual([2, 0, 2]);
	expect(bars[1].close).toBeNaN();
	expect(bars[0].sales.map((sale) => sale.id)).toEqual(['0', '1']);
	expect(bars.flatMap((bar) => bar.sales)).toEqual(history.sales);
	expect(ethText(history.sales[0].unitPrice.numeratorWei)).toBe('1.000000000000000001');
	expect(saleVolumeTooltip(bars[0]).legends).toEqual([
		{ title: 'NFTs: ', value: '2' },
		{ title: 'ETH: ', value: '3.000000000000000001' }
	]);
	expect(saleVolumeTooltip(bars[1]).legends.map((legend) => legend.value)).toEqual(['—', '—']);
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

it('formats fractional-wei averages exactly in hovers while rounding only the visible price', () => {
	const price = { numeratorWei: '1', denominator: '3' };
	expect(unitPriceText(price)).toBe('0.000000000000000001 / 3');
	expect(unitPriceValue(price)).toBeCloseTo(1e-18 / 3, 30);
	expect(salePriceText(price)).toBe('0');
	expect(salePriceText({ numeratorWei: '670500000000000000', denominator: '3' })).toBe('0.224');
	expect(
		salePriceTitle({
			...pricedSaleFixture('6000000000000000000', 'bundle'),
			unitPrice: { numeratorWei: '6000000000000000000', denominator: '4' },
			executionNftQuantity: '4',
			priceBasis: FILL_PRICE_BASIS.BundleAverage,
			currencySymbol: PRICE_HISTORY_CURRENCY_SYMBOL.Eth
		})
	).toBe('1.5 ETH/NFT · bundle average · 6 ETH / 4 NFTs');
});
