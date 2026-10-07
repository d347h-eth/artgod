import type { KLineData, IndicatorCalcCallback, Indicator } from 'klinecharts';
import { FILL_PRICE_BASIS, type ExactUnitPrice } from '@artgod/shared/market-data/fills';
import {
	PRICE_HISTORY_CURRENCY_SYMBOL,
	REALIZED_SALE_ACTION,
	type PriceHistory,
	type RealizedSale,
	type RealizedSaleAction
} from '@artgod/shared/types/price-history';

export const SALE_CURRENCY_LABEL = {
	[PRICE_HISTORY_CURRENCY_SYMBOL.Eth]: 'E',
	[PRICE_HISTORY_CURRENCY_SYMBOL.Weth]: 'W',
	[PRICE_HISTORY_CURRENCY_SYMBOL.Beth]: 'B'
} as const;
const SALE_ACTION_COLOR = {
	[REALIZED_SALE_ACTION.TakeAsk]: 'cyan',
	[REALIZED_SALE_ACTION.TakeOffer]: 'pink'
} as const;
export function saleActionColor(action: RealizedSaleAction | null) {
	return action ? SALE_ACTION_COLOR[action] : 'sand';
}

export const PRICE_CHART_QUERY = {
	Bucket: 'chart_bucket',
	Range: 'chart_range'
} as const;
export const PRICE_INDICATOR = {
	Sma: 'MA',
	Ema: 'EMA',
	Macd: 'MACD',
	Rsi: 'RSI',
	Volume: 'VOL'
} as const;
export type PriceIndicatorKind = (typeof PRICE_INDICATOR)[keyof typeof PRICE_INDICATOR];
export type PriceIndicator = {
	id: string;
	kind: PriceIndicatorKind;
	params: number[];
	enabled: boolean;
};
export const PRICE_INDICATOR_LABEL: Record<PriceIndicatorKind, string> = {
	MA: 'SMA',
	EMA: 'EMA',
	MACD: 'MACD',
	RSI: 'RSI',
	VOL: 'Volume'
};
export const PRICE_INDICATOR_PARAMETERS: Record<PriceIndicatorKind, string[]> = {
	MA: ['Length'],
	EMA: ['Length'],
	MACD: ['Fast', 'Slow', 'Signal'],
	RSI: ['Length'],
	VOL: []
};
export function defaultPriceIndicators(): PriceIndicator[] {
	return [
		{ id: 'sma-20', kind: PRICE_INDICATOR.Sma, params: [20], enabled: false },
		{ id: 'sma-50', kind: PRICE_INDICATOR.Sma, params: [50], enabled: false },
		{ id: 'macd', kind: PRICE_INDICATOR.Macd, params: [12, 26, 9], enabled: false },
		{ id: 'rsi', kind: PRICE_INDICATOR.Rsi, params: [14], enabled: false },
		{ id: 'volume', kind: PRICE_INDICATOR.Volume, params: [], enabled: true }
	];
}
export function validIndicatorParameters(kind: PriceIndicatorKind, params: number[]): boolean {
	return (
		params.length === PRICE_INDICATOR_PARAMETERS[kind].length &&
		params.every((n) => Number.isInteger(n) && n >= 1 && n <= 500) &&
		(kind !== PRICE_INDICATOR.Macd || params[0] < params[1])
	);
}

export type SaleBar = KLineData & {
	sales: RealizedSale[];
	populated: boolean;
	turnoverWei: string | null;
	nftQuantity: string | null;
};

/** Both values refer to the same UTC bucket. Preserve the exact ETH sum for
 * the readout rather than converting it through canvas floating point values. */
export function saleVolumeTooltip(bar: SaleBar | undefined) {
	return {
		name: PRICE_INDICATOR_LABEL.VOL,
		calcParamsText: '',
		features: [],
		legends: [
			{ title: 'NFTs: ', value: bar?.populated ? bar.nftQuantity! : '—' },
			{
				title: 'ETH: ',
				value: bar?.populated && bar.turnoverWei !== null ? ethText(bar.turnoverWei) : '—'
			}
		]
	};
}
export function ethValue(wei: string): number {
	return Number(wei) / 1e18;
}
export function unitPriceValue(price: ExactUnitPrice): number {
	return ethValue(price.numeratorWei) / Number(price.denominator);
}

/** Fit the observed sale distribution, not bucket highs or NFT quantities. The
 * nearest-rank percentile retains at least 95% of observations and all sales in
 * samples smaller than 20. Sorting one price per sale is bounded by the API's
 * observation limit; it never reorders or removes the authoritative sales. */
export function salePriceRange(sales: readonly Pick<RealizedSale, 'unitPrice'>[]) {
	if (!sales.length) return null;
	const prices = sales.map((sale) => unitPriceValue(sale.unitPrice)).sort((a, b) => a - b);
	return { from: prices[0], to: prices[Math.ceil(prices.length * 0.95) - 1] };
}

export function unitPriceText(price: ExactUnitPrice): string {
	const numerator = BigInt(price.numeratorWei),
		denominator = BigInt(price.denominator);
	return numerator % denominator === 0n
		? ethText((numerator / denominator).toString())
		: `${ethText(price.numeratorWei)} / ${price.denominator}`;
}
export function salePriceTitle(
	sale: Pick<
		RealizedSale,
		| 'unitPrice'
		| 'currencySymbol'
		| 'priceBasis'
		| 'quantity'
		| 'executionTotalWei'
		| 'executionNftQuantity'
	>
): string {
	const price = `${unitPriceText(sale.unitPrice)} ${sale.currencySymbol}`;
	return sale.priceBasis === FILL_PRICE_BASIS.BundleAverage
		? `${price}/NFT · bundle average · ${ethText(sale.executionTotalWei)} ${sale.currencySymbol} / ${sale.executionNftQuantity} NFTs`
		: sale.quantity === '1'
			? price
			: `${price}/NFT · ${sale.quantity} NFTs`;
}
export function ethText(wei: string): string {
	const padded = wei.padStart(19, '0');
	const fraction = padded.slice(-18).replace(/0+$/, '');
	return padded.slice(0, -18) + (fraction ? '.' + fraction : '');
}

/** Round sale-row amounts to three decimals without losing precision through Number. */
export function salePriceText(price: ExactUnitPrice): string {
	const incrementWei = 10n ** 15n;
	const divisor = BigInt(price.denominator) * incrementWei;
	const roundedWei = ((2n * BigInt(price.numeratorWei) + divisor) / (2n * divisor)) * incrementWei;
	return ethText(roundedWei.toString());
}

/** Keep equal UTC spacing. NaNs are internal missing values, never serialized,
 * drawn, or passed to a built-in indicator calculator. */
export function saleBars(history: PriceHistory): SaleBar[] {
	const byTime = new Map(history.buckets.map((bar) => [bar.timestamp, bar]));
	const bars: SaleBar[] = [];
	let saleIndex = 0;
	for (let time = history.from; time < history.to; time += history.bucketSeconds) {
		const bar = byTime.get(time);
		const sales: RealizedSale[] = [];
		while (
			saleIndex < history.sales.length &&
			history.sales[saleIndex].timestamp < time + history.bucketSeconds
		) {
			sales.push(history.sales[saleIndex++]);
		}
		bars.push({
			timestamp: time * 1000,
			populated: !!bar,
			sales,
			open: bar ? unitPriceValue(bar.open) : NaN,
			high: bar ? unitPriceValue(bar.high) : NaN,
			low: bar ? unitPriceValue(bar.low) : NaN,
			close: bar ? unitPriceValue(bar.close) : NaN,
			volume: bar ? Number(bar.volume) : 0,
			nftQuantity: bar?.volume ?? null,
			turnover: bar ? ethValue(bar.turnoverWei) : 0,
			turnoverWei: bar?.turnoverWei ?? null
		});
	}
	return bars;
}

// Indicator periods count populated buckets. Compute across the entire loaded
// history (including pre-viewport warmup), then restore blanks on the time grid.
export function withSaleGaps(
	calc: IndicatorCalcCallback<unknown, unknown, unknown>
): IndicatorCalcCallback<unknown, unknown, unknown> {
	return async (data, indicator) => {
		const values = await calc(
			data.filter((bar) => bar.populated),
			indicator
		);
		let i = 0;
		return data.map((bar) => (bar.populated ? values[i++] : {}));
	};
}

// KLineChart's default MACD histogram is doubled. Match MACD - signal here.
export function standardMacd(
	calc: IndicatorCalcCallback<unknown, unknown, unknown>
): IndicatorCalcCallback<unknown, unknown, unknown> {
	return async (data, indicator: Indicator) =>
		(await calc(data, indicator)).map((value) => {
			const result = value as Record<string, number>;
			return Number.isFinite(result.macd) ? { ...result, macd: result.macd / 2 } : result;
		});
}
