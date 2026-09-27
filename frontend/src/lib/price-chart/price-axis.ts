import { registerYAxis, type Chart } from 'klinecharts';

export const CANDLE_PANE = 'candle_pane'; // KLineChart's public price-pane ID.
export const PRICE_PRECISION = 8;
const PRICE_AXIS = 'artgod-sale-price';
let registered = false;

/** Keep native scaling and continuous panning, including below zero. Only the
 * price-label wheel direction and displayed decimal places differ from the library. */
export function createPriceAxis(chart: Chart, element: HTMLElement) {
	if (!registered) {
		registerYAxis({ name: PRICE_AXIS, displayValueToText: (value) => value.toFixed(4) });
		registered = true;
	}
	const reset = () => chart.overrideYAxis({ paneId: CANDLE_PANE, name: PRICE_AXIS });
	reset();
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
	return { reset, dispose: () => element.removeEventListener('wheel', wheel, { capture: true }) };
}
