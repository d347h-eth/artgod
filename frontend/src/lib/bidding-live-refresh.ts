import { TRADING_BIDDING_BID_BOOK_SOURCE } from '@artgod/shared/types';
import type { ApiBiddingBidBook } from '$lib/api-types';

// Polling cadence for passive order-backed bid books.
export const BIDDING_OFFERS_NORMAL_LIVE_POLL_INTERVAL_MS = 10_000;

// Polling cadence for bot-snapshot-backed bid books.
export const BIDDING_OFFERS_COMPETITIVE_LIVE_POLL_INTERVAL_MS = 5_000;

const BIDDING_LIVE_REFRESH_ANCHOR_KIND = {
	OpenSeaOrder: 'open-sea-order',
	BiddingJob: 'bidding-job',
	Token: 'token'
} as const;

// Existing bid-book and token-card markers used to restore viewport position after silent refreshes.
const BIDDING_LIVE_REFRESH_ANCHOR_SELECTOR =
	'[data-open-sea-order-hash], [data-bidding-job-id], [data-token-id]';

const MAX_BIDDING_LIVE_REFRESH_ANCHORS = 12;
const MAX_BIDDING_LIVE_REFRESH_SCROLL_DRIFT_PX = 2;

type BiddingLiveRefreshAnchorKind =
	(typeof BIDDING_LIVE_REFRESH_ANCHOR_KIND)[keyof typeof BIDDING_LIVE_REFRESH_ANCHOR_KIND];

type BiddingLiveRefreshAnchor = {
	kind: BiddingLiveRefreshAnchorKind;
	value: string;
	top: number;
};

type BiddingLiveRefreshAnchorMarker = {
	kind: BiddingLiveRefreshAnchorKind;
	value: string;
	element: HTMLElement;
};

export type BiddingLiveRefreshAnchorSnapshot = {
	rootTop: number | null;
	scrollX: number;
	scrollY: number;
	anchors: BiddingLiveRefreshAnchor[];
};

export type BiddingOffersLiveRefreshHandle = {
	refreshNow(): Promise<void>;
	stop(): void;
};

type BiddingOffersLiveRefreshOptions = {
	refresh: () => Promise<unknown> | unknown;
	intervalMs: () => number;
	onNextUpdate?: (nextUpdateAtMs: number | null) => void;
};

// Chooses the live-poll cadence from the bid-book source selected by the backend read model.
export function biddingOffersLivePollIntervalMs(
	source: ApiBiddingBidBook['state']['source']
): number {
	return source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot
		? BIDDING_OFFERS_COMPETITIVE_LIVE_POLL_INTERVAL_MS
		: BIDDING_OFFERS_NORMAL_LIVE_POLL_INTERVAL_MS;
}

// Poll the current offers page without overlapping backend refreshes.
export function startBiddingOffersLiveRefresh({
	refresh,
	intervalMs,
	onNextUpdate
}: BiddingOffersLiveRefreshOptions): BiddingOffersLiveRefreshHandle {
	let stopped = false;
	let refreshInFlight = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const scheduleNext = (): void => {
		if (stopped) return;
		const delayMs = intervalMs();
		onNextUpdate?.(Date.now() + delayMs);
		timer = setTimeout(() => {
			void runScheduledRefresh();
		}, delayMs);
	};

	const refreshNow = async (): Promise<void> => {
		if (stopped || refreshInFlight) return;
		refreshInFlight = true;
		try {
			await refresh();
		} catch {
			// Keep polling after transient backend or network failures.
		} finally {
			refreshInFlight = false;
		}
	};

	const runScheduledRefresh = async (): Promise<void> => {
		await refreshNow();
		scheduleNext();
	};

	scheduleNext();

	return {
		refreshNow,
		stop() {
			stopped = true;
			onNextUpdate?.(null);
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		}
	};
}

// Captures visible bid/token anchors so silent refreshes can restore the user's viewport.
export function captureBiddingLiveRefreshAnchor(
	root: HTMLElement | null
): BiddingLiveRefreshAnchorSnapshot | null {
	if (!root) return null;
	const rootTop = readElementTop(root);
	const anchors = Array.from(
		root.querySelectorAll<HTMLElement>(BIDDING_LIVE_REFRESH_ANCHOR_SELECTOR)
	)
		.map(resolveBiddingLiveRefreshAnchor)
		.filter((anchor): anchor is BiddingLiveRefreshAnchor => anchor !== null)
		.sort((left, right) => Math.max(left.top, 0) - Math.max(right.top, 0))
		.slice(0, MAX_BIDDING_LIVE_REFRESH_ANCHORS);

	return {
		rootTop,
		scrollX: window.scrollX,
		scrollY: window.scrollY,
		anchors
	};
}

// Restores the first still-present anchor, falling back to the refreshed content root.
export function restoreBiddingLiveRefreshAnchor(
	root: HTMLElement | null,
	snapshot: BiddingLiveRefreshAnchorSnapshot | null
): void {
	if (!root || !snapshot) return;
	if (hasViewportMovedSinceBiddingLiveRefreshCapture(snapshot)) {
		return;
	}
	for (const anchor of snapshot.anchors) {
		const element = findBiddingLiveRefreshAnchorElement(root, anchor);
		if (!element) continue;
		restoreElementTop(element, anchor.top);
		return;
	}
	if (snapshot.rootTop !== null) {
		restoreElementTop(root, snapshot.rootTop);
	}
}

function hasViewportMovedSinceBiddingLiveRefreshCapture(
	snapshot: BiddingLiveRefreshAnchorSnapshot
): boolean {
	return (
		Math.abs(window.scrollX - snapshot.scrollX) > MAX_BIDDING_LIVE_REFRESH_SCROLL_DRIFT_PX ||
		Math.abs(window.scrollY - snapshot.scrollY) > MAX_BIDDING_LIVE_REFRESH_SCROLL_DRIFT_PX
	);
}

function resolveBiddingLiveRefreshAnchor(
	marker: HTMLElement
): BiddingLiveRefreshAnchor | null {
	const resolved = resolveBiddingLiveRefreshAnchorMarker(marker);
	if (!resolved) return null;

	const rect = readElementRect(resolved.element);
	if (!rect || !isElementRectVisibleInViewport(rect)) return null;

	return {
		kind: resolved.kind,
		value: resolved.value,
		top: rect.top
	};
}

function resolveBiddingLiveRefreshAnchorMarker(
	marker: HTMLElement
): BiddingLiveRefreshAnchorMarker | null {
	const element = resolveAnchorElement(marker);
	if (marker.dataset.openSeaOrderHash) {
		return {
			kind: BIDDING_LIVE_REFRESH_ANCHOR_KIND.OpenSeaOrder,
			value: marker.dataset.openSeaOrderHash,
			element
		};
	}
	if (marker.dataset.biddingJobId) {
		return {
			kind: BIDDING_LIVE_REFRESH_ANCHOR_KIND.BiddingJob,
			value: marker.dataset.biddingJobId,
			element
		};
	}
	if (marker.dataset.tokenId) {
		return {
			kind: BIDDING_LIVE_REFRESH_ANCHOR_KIND.Token,
			value: marker.dataset.tokenId,
			element
		};
	}
	return null;
}

function findBiddingLiveRefreshAnchorElement(
	root: HTMLElement,
	anchor: BiddingLiveRefreshAnchor
): HTMLElement | null {
	for (const marker of root.querySelectorAll<HTMLElement>(BIDDING_LIVE_REFRESH_ANCHOR_SELECTOR)) {
		const candidate = resolveBiddingLiveRefreshAnchorMarker(marker);
		if (!candidate || candidate.kind !== anchor.kind || candidate.value !== anchor.value) {
			continue;
		}
		return candidate.element;
	}
	return null;
}

function resolveAnchorElement(marker: HTMLElement): HTMLElement {
	if (marker.dataset.tokenId) {
		return marker;
	}
	return marker.closest('tr') ?? marker;
}

function isElementRectVisibleInViewport(rect: DOMRect): boolean {
	return rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
}

function readElementTop(element: HTMLElement): number | null {
	return readElementRect(element)?.top ?? null;
}

function readElementRect(element: HTMLElement): DOMRect | null {
	const rect = element.getBoundingClientRect();
	return Number.isFinite(rect.top) ? rect : null;
}

function restoreElementTop(element: HTMLElement, previousTop: number): void {
	const nextTop = readElementTop(element);
	if (nextTop === null) return;
	const delta = nextTop - previousTop;
	if (Math.abs(delta) < 1) return;
	window.scrollTo(window.scrollX, window.scrollY + delta);
}
