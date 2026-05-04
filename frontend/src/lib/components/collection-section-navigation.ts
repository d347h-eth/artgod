import { goto } from '$app/navigation';
import type { ActivityFeedFilterKind } from '@artgod/shared/types';
import { ACTIVITY_KIND_QUERY_PARAM } from '$lib/activity-query';
import { BIDDING_VIEW_QUERY_PARAM, type CollectionBiddingViewMode } from '$lib/bidding-query';
import { isKeyboardTextEntryTarget } from '$lib/components/keyboard-targets';
import { joinPath, normalizeBasePath, withQuery } from '$lib/route-paths';
import { TOKEN_STATUS_QUERY_PARAM, type CollectionTokenStatus } from '$lib/token-browser-query';

export type CollectionSectionNavigationConfig = {
	tokensBasePath: string;
	tokensQuery?: URLSearchParams;
	activitiesBasePath: string;
	activitiesQuery?: URLSearchParams;
	biddingBasePath: string;
	biddingQuery?: URLSearchParams;
	showBidding?: boolean;
};

export function collectionTokenStatusHref(
	config: CollectionSectionNavigationConfig,
	tokenStatus: CollectionTokenStatus
): string {
	const query = new URLSearchParams(config.tokensQuery);
	query.set(TOKEN_STATUS_QUERY_PARAM, tokenStatus);
	return withQuery(normalizeBasePath(config.tokensBasePath), query);
}

export function collectionActivityKindHref(
	config: CollectionSectionNavigationConfig,
	kind: ActivityFeedFilterKind
): string {
	const query = new URLSearchParams(config.activitiesQuery);
	query.set(ACTIVITY_KIND_QUERY_PARAM, kind);
	return withQuery(joinPath(config.activitiesBasePath, 'activity'), query);
}

export function collectionBiddingViewHref(
	config: CollectionSectionNavigationConfig,
	view: CollectionBiddingViewMode
): string | null {
	if (config.showBidding === false) return null;
	const query = new URLSearchParams(config.biddingQuery);
	if (view === 'bid_book') {
		query.delete(BIDDING_VIEW_QUERY_PARAM);
	} else {
		query.set(BIDDING_VIEW_QUERY_PARAM, view);
	}
	return withQuery(joinPath(config.biddingBasePath, 'bidding'), query);
}

// Applies collection-level numeric navigation after modal/text-input guards in page key handlers.
export function handleCollectionSectionShortcut(
	event: KeyboardEvent,
	config: CollectionSectionNavigationConfig
): boolean {
	const href = resolveCollectionSectionShortcutHref(event, config);
	if (!href) return false;
	event.preventDefault();
	void goto(href, {
		invalidateAll: true,
		keepFocus: true,
		noScroll: true
	});
	return true;
}

export function resolveCollectionSectionShortcutHref(
	event: KeyboardEvent,
	config: CollectionSectionNavigationConfig
): string | null {
	if (event.defaultPrevented) return null;
	if (event.metaKey || event.ctrlKey || event.altKey) return null;
	if (isKeyboardTextEntryTarget(event.target)) return null;

	switch (event.key) {
		case '1':
			return collectionTokenStatusHref(config, 'listed');
		case '2':
			return collectionBiddingViewHref(config, 'bid_book');
		case '3':
			return collectionTokenStatusHref(config, 'all');
		case '4':
			return collectionBiddingViewHref(config, 'jobs');
		default:
			return null;
	}
}
