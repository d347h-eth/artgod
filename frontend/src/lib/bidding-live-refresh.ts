import { TRADING_BIDDING_BID_BOOK_SOURCE } from '@artgod/shared/types';
import {
	DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG,
	type BiddingBidBookLiveRefreshConfig
} from '@artgod/shared/config/bidding';
import type { ApiBiddingBidBook } from '$lib/api-types';
import {
	startScheduledLiveRefresh,
	type ScheduledLiveRefreshHandle
} from '$lib/live-refresh';

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

export type BiddingBidBookLiveRefreshHandle = ScheduledLiveRefreshHandle;

type BiddingBidBookLiveRefreshOptions = {
	refresh: () => Promise<unknown> | unknown;
	intervalMs: () => number;
	onNextUpdate?: (nextUpdateAtMs: number | null) => void;
};

// Chooses the live-poll cadence from the bid-book source selected by the backend read model.
export function biddingBidBookLivePollIntervalMs(
	source: ApiBiddingBidBook['state']['source'],
	config: BiddingBidBookLiveRefreshConfig = DEFAULT_BIDDING_BID_BOOK_LIVE_REFRESH_CONFIG
): number {
	return source === TRADING_BIDDING_BID_BOOK_SOURCE.BotSnapshot
		? config.competitivePollMs
		: config.normalPollMs;
}

// Poll the current bid-book view without overlapping backend refreshes.
export function startBiddingBidBookLiveRefresh({
	refresh,
	intervalMs,
	onNextUpdate
}: BiddingBidBookLiveRefreshOptions): BiddingBidBookLiveRefreshHandle {
	return startScheduledLiveRefresh({ refresh, intervalMs, onNextUpdate });
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
