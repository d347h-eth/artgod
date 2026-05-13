import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPointerFocusRelease } from './pointer-focus-release';

const originalElement = globalThis.Element;
const originalHTMLElement = globalThis.HTMLElement;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

class FakeElement {
	blurCalls = 0;

	constructor(private readonly releasable: boolean) {}

	closest(): FakeElement | null {
		return this.releasable ? this : null;
	}

	matches(): boolean {
		return this.releasable;
	}

	blur(): void {
		this.blurCalls += 1;
	}
}

describe('installPointerFocusRelease', () => {
	beforeEach(() => {
		globalThis.Element = FakeElement as unknown as typeof Element;
		globalThis.HTMLElement = FakeElement as unknown as typeof HTMLElement;
		globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
			callback(0);
			return 0;
		}) as typeof requestAnimationFrame;
	});

	afterEach(() => {
		globalThis.Element = originalElement;
		globalThis.HTMLElement = originalHTMLElement;
		globalThis.requestAnimationFrame = originalRequestAnimationFrame;
	});

	it('releases focus from pointer-activated controls through one shared listener', () => {
		let listener: ((event: PointerEvent) => void) | null = null;
		const activeElement = new FakeElement(true);
		const target = new FakeElement(true);
		const documentRef = {
			activeElement,
			addEventListener: vi.fn((_type: string, callback: (event: PointerEvent) => void) => {
				listener = callback;
			}),
			removeEventListener: vi.fn()
		} as unknown as Document;

		const uninstall = installPointerFocusRelease(documentRef);
		const onPointerUp = requireListener(listener);
		onPointerUp({ target } as unknown as PointerEvent);
		uninstall();

		expect(activeElement.blurCalls).toBe(1);
		expect(documentRef.addEventListener).toHaveBeenCalledWith('pointerup', expect.any(Function), true);
		expect(documentRef.removeEventListener).toHaveBeenCalledWith(
			'pointerup',
			expect.any(Function),
			true
		);
	});
});

function requireListener(
	value: ((event: PointerEvent) => void) | null
): (event: PointerEvent) => void {
	if (!value) throw new Error('pointer listener was not registered');
	return value;
}
