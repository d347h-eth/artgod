export const PREVIEW_BACKDROP_GESTURE_DEFAULTS = {
	tapTolerancePx: 10,
	minHorizontalSwipePx: 40,
	maxVerticalDriftPx: 28,
	maxSwipeDurationMs: 450,
	horizontalDominanceRatio: 1.5
} as const;

export type PreviewBackdropGestureKind = 'tap' | 'previous' | 'next' | 'ignore';

export function resolvePreviewBackdropGesture(params: {
	dx: number;
	dy: number;
	durationMs: number;
}): PreviewBackdropGestureKind {
	const absDx = Math.abs(params.dx);
	const absDy = Math.abs(params.dy);

	if (
		absDx <= PREVIEW_BACKDROP_GESTURE_DEFAULTS.tapTolerancePx &&
		absDy <= PREVIEW_BACKDROP_GESTURE_DEFAULTS.tapTolerancePx
	) {
		return 'tap';
	}

	if (params.durationMs > PREVIEW_BACKDROP_GESTURE_DEFAULTS.maxSwipeDurationMs) {
		return 'ignore';
	}

	if (absDx < PREVIEW_BACKDROP_GESTURE_DEFAULTS.minHorizontalSwipePx) {
		return 'ignore';
	}

	if (absDy > PREVIEW_BACKDROP_GESTURE_DEFAULTS.maxVerticalDriftPx) {
		return 'ignore';
	}

	if (absDx < absDy * PREVIEW_BACKDROP_GESTURE_DEFAULTS.horizontalDominanceRatio) {
		return 'ignore';
	}

	return params.dx > 0 ? 'previous' : 'next';
}
