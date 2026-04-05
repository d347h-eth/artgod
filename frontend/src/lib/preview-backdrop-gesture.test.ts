import { describe, expect, it } from 'vitest';
import { resolvePreviewBackdropGesture } from './preview-backdrop-gesture';

describe('preview-backdrop-gesture', () => {
	it('treats short nearly-stationary interaction as a tap', () => {
		expect(
			resolvePreviewBackdropGesture({
				dx: 6,
				dy: -4,
				durationMs: 180
			})
		).toBe('tap');
	});

	it('resolves a horizontal left swipe to next token', () => {
		expect(
			resolvePreviewBackdropGesture({
				dx: -56,
				dy: 10,
				durationMs: 220
			})
		).toBe('next');
	});

	it('resolves a horizontal right swipe to previous token', () => {
		expect(
			resolvePreviewBackdropGesture({
				dx: 62,
				dy: 8,
				durationMs: 240
			})
		).toBe('previous');
	});

	it('ignores slow drags that exceed swipe duration', () => {
		expect(
			resolvePreviewBackdropGesture({
				dx: -70,
				dy: 6,
				durationMs: 700
			})
		).toBe('ignore');
	});

	it('ignores diagonals that drift too far vertically', () => {
		expect(
			resolvePreviewBackdropGesture({
				dx: -64,
				dy: 34,
				durationMs: 210
			})
		).toBe('ignore');
	});
});
