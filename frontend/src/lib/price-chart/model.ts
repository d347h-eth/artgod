import type { KLineData, IndicatorCalcCallback, Indicator } from 'klinecharts';
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
};

/** Both values refer to the same UTC bucket. Preserve the exact ETH sum for
 * the readout rather than converting it through canvas floating point values. */
export function saleVolumeTooltip(bar: SaleBar | undefined) {
	return {
		name: PRICE_INDICATOR_LABEL.VOL,
		calcParamsText: '',
		features: [],
		legends: [
			{ title: 'NFTs: ', value: bar?.populated ? String(bar.volume) : '—' },
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
export function ethText(wei: string): string {
	const padded = wei.padStart(19, '0');
	const fraction = padded.slice(-18).replace(/0+$/, '');
	return padded.slice(0, -18) + (fraction ? '.' + fraction : '');
}

/** Round sale-row amounts to three decimals without losing precision through Number. */
export function salePriceText(wei: string): string {
	const incrementWei = 10n ** 15n;
	const roundedWei = ((BigInt(wei) + incrementWei / 2n) / incrementWei) * incrementWei;
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
			open: bar ? ethValue(bar.openWei) : NaN,
			high: bar ? ethValue(bar.highWei) : NaN,
			low: bar ? ethValue(bar.lowWei) : NaN,
			close: bar ? ethValue(bar.closeWei) : NaN,
			volume: bar?.volume ?? 0,
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
