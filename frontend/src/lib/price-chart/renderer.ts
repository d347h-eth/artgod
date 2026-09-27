import {
	init,
	dispose,
	registerIndicator,
	type IndicatorDrawParams,
	type DeepPartial,
	type Styles,
	type Coordinate
} from 'klinecharts';
import type { PriceHistory, RealizedSale } from '@artgod/shared/types/price-history';
import { CANDLE_PANE, PRICE_PRECISION, createPriceAxis } from './price-axis';
import {
	PRICE_INDICATOR,
	PRICE_INDICATOR_LABEL,
	saleBars,
	saleVolumeTooltip,
	saleActionColor,
	ethValue,
	withSaleGaps,
	standardMacd,
	type SaleBar,
	type PriceIndicator
} from './model';

const PRICE_LAYER = 'artgod-realized-sales';
const NO_AREA_VALUE = 'artgod_no_area_value';
const HIT_SIZE = 12;
type Hit = Coordinate & { sale: RealizedSale };
type Palette = {
	bg: string;
	cyan: string;
	blue: string;
	pink: string;
	sand: string;
	ice: string;
	yellow: string;
	orange: string;
};
type PriceDrawing = {
	selected: Set<string>;
	seconds: number;
	palette: Palette;
	hits: Map<string, Hit[]>;
	onSalesAboveView: (centerX: number | null) => void;
};
let registered = false;
function registerPriceLayer() {
	if (registered) return;
	registered = true;
	registerIndicator<unknown>({
		name: PRICE_LAYER,
		shortName: '',
		series: 'price',
		precision: PRICE_PRECISION,
		// Invisible figures establish the full sale-price range for the dot layer.
		figures: [
			{ key: 'high', type: 'line' },
			{ key: 'low', type: 'line' }
		],
		calc: (data) => data.map((bar) => (bar.populated ? { high: bar.high, low: bar.low } : {})),
		draw: (input) => {
			drawPrices(input);
			return true;
		},
		createTooltipDataSource: () => ({ name: '', calcParamsText: '', legends: [], features: [] })
	});
}
function palette(element: HTMLElement): Palette {
	const css = getComputedStyle(element);
	return Object.fromEntries(
		['bg', 'cyan', 'blue', 'pink', 'sand', 'ice', 'yellow', 'orange'].map((key) => [
			key,
			css.getPropertyValue('--c-' + key).trim()
		])
	) as Palette;
}
function chartStyles(p: Palette): DeepPartial<Styles> {
	const axis = {
		axisLine: { color: p.blue },
		tickLine: { color: p.blue },
		tickText: { color: p.sand, family: 'monospace', size: 11 }
	};
	const crosshair = {
		line: { color: p.sand },
		text: { backgroundColor: p.blue, color: p.ice, borderColor: p.blue }
	};
	return {
		grid: { horizontal: { color: p.blue }, vertical: { color: p.blue } },
		// A custom price layer handles gaps and scatter. The native area layer is
		// deliberately empty so NaN OHLC cannot poison native candle autoscaling.
		candle: {
			type: 'area',
			area: { value: NO_AREA_VALUE, point: { show: false, animation: false } },
			priceMark: { show: false },
			tooltip: { showRule: 'none' }
		},
		xAxis: axis,
		yAxis: axis,
		separator: { color: p.blue, activeBackgroundColor: p.orange },
		crosshair: { horizontal: crosshair, vertical: crosshair },
		indicator: {
			ohlc: { upColor: p.cyan, downColor: p.pink, noChangeColor: p.sand },
			lines: [p.yellow, p.orange, p.cyan, p.pink, p.sand].map((color) => ({
				color,
				size: 1,
				smooth: false
			})),
			bars: [{ upColor: p.cyan, downColor: p.pink, noChangeColor: p.sand, style: 'fill' }],
			circles: [{ upColor: p.cyan, downColor: p.pink, noChangeColor: p.sand }],
			lastValueMark: { show: false },
			tooltip: { title: { color: p.sand }, legend: { color: p.ice } }
		}
	};
}
function drawPrices({
	ctx,
	chart,
	indicator,
	bounding,
	xAxis,
	yAxis
}: IndicatorDrawParams<unknown, unknown, unknown>) {
	const drawing = (indicator.extendData as (() => PriceDrawing) | undefined)?.();
	if (!drawing) return;
	drawing.hits.clear();
	const bars = chart.getDataList() as SaleBar[];
	const { from, to } = chart.getVisibleRange();
	const p = drawing.palette;
	let salesAboveView = false;
	const points = new Map<
		string,
		{ x: number; y: number; colors: Set<string>; selected: boolean }
	>();
	ctx.save();
	ctx.lineWidth = 1;
	for (let i = Math.max(0, from - 1); i < Math.min(bars.length, to + 1); i++) {
		const bar = bars[i];
		if (!bar.populated) continue;
		for (const sale of bar.sales) {
			// Fractional indices retain sub-bucket time, including identical
			// timestamps. No jitter, deduplication, or timestamp overwrite.
			const index = i - 0.5 + (sale.timestamp - bar.timestamp / 1000) / drawing.seconds;
			const sx = xAxis.convertToPixel(index);
			const y = yAxis.convertToPixel(ethValue(sale.priceWei));
			// Use exact dot positions, including partial buckets at either time edge.
			if (sx >= 0 && sx <= bounding.width && y < 0) salesAboveView = true;
			const selected = drawing.selected.has(sale.id);
			const coordinate = sx + ':' + y;
			const point = points.get(coordinate) ?? {
				x: sx,
				y,
				colors: new Set<string>(),
				selected: false
			};
			point.colors.add(p[saleActionColor(sale.action)]);
			point.selected ||= selected;
			points.set(coordinate, point);
			const key = hitKey(sx, y);
			const hits = drawing.hits.get(key) ?? [];
			hits.push({ x: sx, y, sale });
			drawing.hits.set(key, hits);
		}
	}
	for (const point of points.values()) {
		// Exact overlaps can include both order sides. Show each observed type as
		// a sector instead of letting the last fill hide the other type's color.
		const colors = point.selected ? [p.orange] : [...point.colors];
		colors.forEach((color, i) => {
			ctx.fillStyle = color;
			ctx.beginPath();
			if (colors.length > 1) ctx.moveTo(point.x, point.y);
			ctx.arc(
				point.x,
				point.y,
				point.selected ? 5 : 3,
				(i / colors.length) * Math.PI * 2,
				((i + 1) / colors.length) * Math.PI * 2
			);
			ctx.closePath();
			ctx.fill();
		});
	}
	ctx.restore();
	drawing.onSalesAboveView(salesAboveView ? bounding.left + bounding.width / 2 : null);
}
function hitKey(x: number, y: number): string {
	return Math.floor(x / HIT_SIZE) + ':' + Math.floor(y / HIT_SIZE);
}

export function createPriceChart(
	element: HTMLElement,
	onSalesAboveView: (centerX: number | null) => void
) {
	registerPriceLayer();
	const colors = palette(element);
	const chart = init(element, {
		timezone: 'UTC',
		locale: 'en-US',
		styles: chartStyles(colors),
		hotkey: { enabled: false }
	});
	if (!chart) throw new Error('Chart initialization failed');
	const drawing: PriceDrawing = {
		selected: new Set(),
		seconds: 86400,
		palette: colors,
		hits: new Map(),
		onSalesAboveView
	};
	let currentHistory: PriceHistory | null = null;
	const active = new Map<string, { id: string; kind: PriceIndicator['kind'] }>();
	chart.setSymbol({ ticker: 'ETH', pricePrecision: PRICE_PRECISION, volumePrecision: 0 });
	chart.setPeriod({ type: 'day', span: 1 });
	chart.setOffsetRightDistance(20);
	// KLineChart deep-clones extendData objects. A callback preserves ownership
	// of the hit-test Map without relying on undocumented store internals.
	const priceId = chart.createIndicator(
		{ name: PRICE_LAYER, paneId: CANDLE_PANE, extendData: () => drawing },
		true
	)!;
	const priceAxis = createPriceAxis(chart, element);
	const observer = new ResizeObserver(() => chart.resize());
	observer.observe(element);

	return {
		setHistory(history: PriceHistory) {
			priceAxis.reset();
			currentHistory = history;
			drawing.seconds = history.bucketSeconds;
			drawing.hits.clear();
			const bars = saleBars(history);
			chart.setPeriod(
				history.bucketSeconds < 86400
					? { type: 'hour', span: history.bucketSeconds / 3600 }
					: history.bucketSeconds === 604800
						? { type: 'week', span: 1 }
						: { type: 'day', span: 1 }
			);
			chart.setDataLoader({
				getBars: ({ type, callback }) => callback(type === 'init' ? bars : [], false)
			});
		},
		setSelection(sales: RealizedSale[]) {
			drawing.selected = new Set(sales.map((sale) => sale.id));
			chart.overrideIndicator({ name: PRICE_LAYER, id: priceId, extendData: () => drawing });
		},
		setIndicators(indicators: PriceIndicator[]) {
			const enabled = indicators.filter((item) => item.enabled);
			for (const [key, indicator] of active) {
				if (!enabled.some((item) => item.id === key && item.kind === indicator.kind)) {
					chart.removeIndicator({ id: indicator.id });
					active.delete(key);
				}
			}
			let averageIndex = 0;
			enabled.forEach((setting) => {
				const inPricePane =
					setting.kind === PRICE_INDICATOR.Sma || setting.kind === PRICE_INDICATOR.Ema;
				const averageColor = [colors.yellow, colors.orange, colors.pink, colors.sand][
					averageIndex % 4
				];
				if (inPricePane) averageIndex++;
				let found = active.get(setting.id);
				if (!found) {
					const id = chart.createIndicator(
						{
							name: setting.kind,
							shortName: PRICE_INDICATOR_LABEL[setting.kind],
							...(inPricePane ? { paneId: CANDLE_PANE } : {}),
							calcParams: setting.params,
							precision: inPricePane
								? PRICE_PRECISION
								: setting.kind === PRICE_INDICATOR.Volume
									? 0
									: 4
						},
						true
					);
					if (!id) return;
					const indicator = chart.getIndicators({ id })[0];
					const calc =
						setting.kind === PRICE_INDICATOR.Macd ? standardMacd(indicator.calc) : indicator.calc;
					chart.overrideIndicator({
						name: setting.kind,
						id,
						calc: withSaleGaps(calc),
						...(setting.kind === PRICE_INDICATOR.Volume
							? {
									createTooltipDataSource: ({ chart, crosshair }) =>
										saleVolumeTooltip(
											(chart.getDataList() as SaleBar[])[
												crosshair.dataIndex ?? chart.getDataList().length - 1
											]
										)
								}
							: {}),
						styles: inPricePane
							? {
									lines: [
										{
											color: averageColor,
											size: 1
										}
									]
								}
							: undefined
					});
					if (!inPricePane)
						chart.setPaneOptions({
							id: indicator.paneId,
							height: 110,
							minHeight: 70,
							dragEnabled: true
						});
					found = { id, kind: setting.kind };
					active.set(setting.id, found);
				}
				chart.overrideIndicator({ name: setting.kind, id: found.id, calcParams: setting.params });
			});
		},
		fit() {
			const size = chart.getSize(CANDLE_PANE, 'main');
			if (!size || !currentHistory) return;
			chart.setBarSpace(
				Math.max(1, Math.min(40, (size.width - 30) / Math.max(1, chart.getDataList().length)))
			);
			chart.scrollToRealTime();
		},
		resetPriceScale() {
			priceAxis.reset();
		},
		salesAt(clientX: number, clientY: number): RealizedSale[] {
			const rect = chart.getDom(CANDLE_PANE, 'main')?.getBoundingClientRect();
			if (!rect) return [];
			const x = clientX - rect.left,
				y = clientY - rect.top;
			const hits: Hit[] = [];
			for (let dx = -1; dx <= 1; dx++)
				for (let dy = -1; dy <= 1; dy++) {
					for (const hit of drawing.hits.get(hitKey(x + dx * HIT_SIZE, y + dy * HIT_SIZE)) ?? []) {
						if (Math.hypot(hit.x - x, hit.y - y) <= 7) hits.push(hit);
					}
				}
			return hits
				.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))
				.map((hit) => hit.sale);
		},
		dispose() {
			observer.disconnect();
			priceAxis.dispose();
			dispose(chart);
		}
	};
}
export type PriceChartController = ReturnType<typeof createPriceChart>;
