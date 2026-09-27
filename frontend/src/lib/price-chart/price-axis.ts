import { registerYAxis, type AxisRange, type Chart } from 'klinecharts';

export const CANDLE_PANE = 'candle_pane'; // KLineChart's public price-pane ID.
export const PRICE_PRECISION = 8;
const PRICE_AXIS = 'artgod-sale-price';
const MIN_SPAN = 10 ** -PRICE_PRECISION;
let registered = false;

function priceRange(from: number, to: number): AxisRange {
	// Shift a window that reaches below zero without changing its zoom. Retain
	// enough span for both tiny prices and floating-point resolution at large prices.
	const span = Math.max(to - from, MIN_SPAN, Math.abs(to) * Number.EPSILON * 8);
	from = Math.max(0, from);
	to = from + span;
	const range = to - from;
	return {
		from,
		to,
		range,
		realFrom: from,
		realTo: to,
		realRange: range,
		displayFrom: from,
		displayTo: to,
		displayRange: range
	};
}

/** Own price-axis gestures so automatic and manual ranges share the zero floor.
 * KLineCharts' native manual range changes bypass its public createRange hook.
 * Keep the library's time-axis navigation and other indicator axes unchanged.
 */
export function createPriceAxis(chart: Chart, element: HTMLElement) {
	if (!registered) {
		registerYAxis({
			name: PRICE_AXIS,
			displayValueToText: (value) => value.toFixed(4),
			// Range padding and minimum span are applied before the zero clamp below.
			minSpan: () => 0
		});
		registered = true;
	}
	let manual: AxisRange | null = null;
	let drag: {
		pointerId: number;
		startY: number;
		range: AxisRange;
		height: number;
		axis: boolean;
	} | null = null;
	const refresh = () => chart.overrideYAxis({ paneId: CANDLE_PANE });
	const reset = () => {
		manual = null;
		drag = null;
		refresh();
	};
	const current = () => manual ?? chart.getYAxes({ paneId: CANDLE_PANE })[0]?.getRange();
	const within = (event: Event, position: 'main' | 'yAxis') =>
		event.target instanceof Node && chart.getDom(CANDLE_PANE, position)?.contains(event.target);
	const apply = (from: number, to: number) => {
		if (!Number.isFinite(from) || !Number.isFinite(to)) return;
		const next = priceRange(from, to);
		if (!Number.isFinite(next.to)) return;
		if (manual?.from === next.from && manual.to === next.to) return;
		manual = next;
		refresh();
	};
	chart.overrideYAxis({
		paneId: CANDLE_PANE,
		name: PRICE_AXIS,
		scrollZoomEnabled: false,
		gap: { top: 0, bottom: 0 },
		createRange: ({ defaultRange }) => {
			if (manual) return manual;
			let { from, to } = defaultRange;
			if (to - from < MIN_SPAN) {
				from -= 4 * MIN_SPAN;
				to += 4 * MIN_SPAN;
			}
			const span = to - from;
			return priceRange(from - span * 0.1, to + span * 0.2);
		}
	});
	const wheel = (event: WheelEvent) => {
		if (!within(event, 'yAxis') || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
		const range = current();
		if (!range || event.deltaY === 0) return;
		event.preventDefault();
		const unit =
			event.deltaMode === WheelEvent.DOM_DELTA_PAGE
				? 120
				: event.deltaMode === WheelEvent.DOM_DELTA_LINE
					? 32
					: 1;
		// Invert the library's price-axis wheel: up contracts, down expands.
		const scale = 1 + Math.max(-1, Math.min(1, (event.deltaY / 100) * unit)) * 0.05;
		const half = (range.range * scale) / 2;
		const center = range.from + range.range / 2;
		apply(center - half, center + half);
	};
	const down = (event: PointerEvent) => {
		if (event.button !== 0 || !event.isPrimary) return;
		const axis = !!within(event, 'yAxis');
		if (!axis && (!manual || !within(event, 'main'))) return;
		const range = current();
		const height = chart.getSize(CANDLE_PANE, 'main')?.height;
		if (range && height)
			drag = { pointerId: event.pointerId, startY: event.pageY, range, height, axis };
	};
	const move = (event: PointerEvent) => {
		if (!drag || event.pointerId !== drag.pointerId) return;
		const { range, startY, height, axis } = drag;
		if (axis) {
			// Preserve the existing axis-drag gesture, with the same zero boundary.
			const half = (range.range * Math.max(0, event.pageY)) / Math.max(1, startY) / 2;
			const center = range.from + range.range / 2;
			apply(center - half, center + half);
		} else {
			const offset = (range.range * (event.pageY - startY)) / height;
			apply(range.from + offset, range.to + offset);
		}
	};
	const stop = () => {
		drag = null;
	};
	const doubleClick = (event: MouseEvent) => {
		if (within(event, 'yAxis')) reset();
	};
	const listeners = new AbortController();
	const options = { signal: listeners.signal };
	element.addEventListener('wheel', wheel, { ...options, capture: true, passive: false });
	element.addEventListener('pointerdown', down, options);
	element.addEventListener('dblclick', doubleClick, options);
	window.addEventListener('pointermove', move, options);
	window.addEventListener('pointerup', stop, options);
	window.addEventListener('pointercancel', stop, options);
	window.addEventListener('blur', stop, options);
	return { reset, dispose: () => listeners.abort() };
}
