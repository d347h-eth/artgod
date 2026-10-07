import { registerYAxis, type Chart } from 'klinecharts';

export const CANDLE_PANE = 'candle_pane'; // KLineChart's public price-pane ID.
export const PRICE_PRECISION = 8;
const PRICE_LABEL_PRECISION = 4;
const PRICE_AXIS = 'artgod-sale-price';
let registered = false;

/** Native padding and manual navigation apply to both the fitted distribution
 * and the full price range. Double-clicking the axis restores the full range. */
export function createPriceAxis(chart: Chart, element: HTMLElement) {
	if (!registered) {
		registerYAxis({
			name: PRICE_AXIS,
			displayValueToText: (value) => value.toFixed(PRICE_LABEL_PRECISION)
		});
		registered = true;
	}
	const reset = () =>
		chart.overrideYAxis({
			paneId: CANDLE_PANE,
			name: PRICE_AXIS,
			createRange: ({ defaultRange }) => defaultRange
		});
	reset();
	const fit = ({ from, to }: { from: number; to: number }) => {
		if (from === to) {
			// Native minimum spans use calculation precision, which would repeat
			// the same four-decimal label at every tick for a flat distribution.
			const margin = Math.max(Math.abs(to) * 0.05, 10 ** (1 - PRICE_LABEL_PRECISION));
			from = Math.max(0, from - margin);
			to += margin;
		}
		const span = to - from;
		chart.overrideYAxis({
			paneId: CANDLE_PANE,
			name: PRICE_AXIS,
			// The library adds its normal top/bottom padding. Wheel and drag
			// gestures still own manual ranges.
			createRange: () => ({
				from,
				to,
				range: span,
				realFrom: from,
				realTo: to,
				realRange: span,
				displayFrom: from,
				displayTo: to,
				displayRange: span
			})
		});
	};
	const doubleClick = (event: MouseEvent) => {
		if (event.target instanceof Node && chart.getDom(CANDLE_PANE, 'yAxis')?.contains(event.target))
			reset();
	};
	let forwarding = false;
	const wheel = (event: WheelEvent) => {
		if (forwarding || Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.deltaY === 0) return;
		const target = event.target;
		if (!(target instanceof Node) || !chart.getDom(CANDLE_PANE, 'yAxis')?.contains(target)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		// Send the inverted gesture through the native handler, which also owns
		// manual-scale state used by dragging, panning, and double-click reset.
		forwarding = true;
		try {
			target.dispatchEvent(
				new WheelEvent(event.type, {
					bubbles: true,
					cancelable: true,
					composed: true,
					clientX: event.clientX,
					clientY: event.clientY,
					screenX: event.screenX,
					screenY: event.screenY,
					button: event.button,
					buttons: event.buttons,
					deltaX: event.deltaX,
					deltaY: -event.deltaY,
					deltaZ: event.deltaZ,
					deltaMode: event.deltaMode,
					ctrlKey: event.ctrlKey,
					altKey: event.altKey,
					shiftKey: event.shiftKey,
					metaKey: event.metaKey
				})
			);
		} finally {
			forwarding = false;
		}
	};
	element.addEventListener('wheel', wheel, { capture: true, passive: false });
	element.addEventListener('dblclick', doubleClick, { capture: true });
	return {
		fit,
		reset,
		dispose: () => {
			element.removeEventListener('wheel', wheel, { capture: true });
			element.removeEventListener('dblclick', doubleClick, { capture: true });
		}
	};
}
