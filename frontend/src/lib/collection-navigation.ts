import { goto } from '$app/navigation';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { ActivityFeedFilterKind } from '@artgod/shared/types';
import {
	ACTIVITY_KIND_QUERY_PARAM,
	buildCollectionActivityQuery,
	COLLECTION_ACTIVITY_FILTER_KINDS
} from '$lib/activity-query';
import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';
import {
	BIDDING_VIEW_QUERY_PARAM,
	buildCollectionBiddingQuery,
	type CollectionBiddingBidScopeFilter,
	type CollectionBiddingTraitFilterJoinMode,
	type CollectionBiddingViewMode
} from '$lib/bidding-query';
import { isKeyboardTextEntryTarget } from '$lib/components/keyboard-targets';
import { buildCollectionCustomizationHref } from '$lib/customization-query';
import { appendMediaModeParam } from '$lib/media-mode';
import { joinPath, normalizeBasePath, withQuery } from '$lib/route-paths';
import { TOKEN_STATUS_QUERY_PARAM, type CollectionTokenStatus } from '$lib/token-browser-query';
import { buildCollectionTokenNavigationQuery } from '$lib/token-browser-navigation-preferences';

export type CollectionNavigationState = {
	basePath: string;
	mediaMode?: string | null;
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	token?: {
		limit?: number;
		displayMode?: 'grid' | 'table';
	};
	activity?: {
		limit?: number;
		kind?: ActivityFeedFilterKind;
	};
	bidding?: {
		enabled?: boolean;
		showOffers?: boolean;
		showJobs?: boolean;
		bidScope?: CollectionBiddingBidScopeFilter;
		traitJoinMode?: CollectionBiddingTraitFilterJoinMode;
		viewMode?: CollectionBiddingViewMode;
		showMuted?: boolean;
	};
};

export type CollectionNavigation = {
	basePath: string;
	showBiddingOffers: boolean;
	showBiddingJobs: boolean;
	queries: {
		tokens: URLSearchParams;
		activities: URLSearchParams;
		bidding: URLSearchParams;
	};
	hrefs: {
		asks: string;
		offers: string | null;
		tokens: string;
		bidding: string | null;
		holders: string;
		customization: string;
		tokenStatus: (tokenStatus: CollectionTokenStatus) => string;
		activityKind: (kind: ActivityFeedFilterKind) => string;
		biddingView: (view: CollectionBiddingViewMode) => string | null;
	};
};

export function buildCollectionNavigation(state: CollectionNavigationState): CollectionNavigation {
	const normalizedBasePath = normalizeBasePath(state.basePath);
	const mediaMode = state.mediaMode ?? null;
	const tokenLimit = state.token?.limit ?? DEFAULT_PAGE_LIMIT;
	const tokenDisplayMode = state.token?.displayMode ?? 'grid';
	const activityLimit = state.activity?.limit ?? tokenLimit;
	const activityKind = state.activity?.kind ?? COLLECTION_ACTIVITY_FILTER_KINDS[0];
	const defaultBiddingVisibility = state.bidding?.enabled ?? true;
	const showBiddingOffers = state.bidding?.showOffers ?? defaultBiddingVisibility;
	const showBiddingJobs = state.bidding?.showJobs ?? defaultBiddingVisibility;

	const tokenQuery = buildCollectionTokenNavigationQuery({
		limit: tokenLimit,
		displayMode: tokenDisplayMode,
		selectedTraits: state.selectedTraits,
		selectedTraitRanges: state.selectedTraitRanges,
		mediaMode
	});
	const activityQuery = buildCollectionActivityQuery({
		limit: activityLimit,
		kind: activityKind,
		selectedTraits: state.selectedTraits,
		selectedTraitRanges: state.selectedTraitRanges,
		mediaMode
	});
	const biddingQuery = buildCollectionBiddingQuery({
		selectedTraits: state.selectedTraits,
		selectedTraitRanges: state.selectedTraitRanges,
		bidScope: state.bidding?.bidScope,
		traitJoinMode: state.bidding?.traitJoinMode,
		viewMode: state.bidding?.viewMode,
		mediaMode,
		showMuted: state.bidding?.showMuted
	});

	const tokenStatusHref = (tokenStatus: CollectionTokenStatus): string => {
		const query = new URLSearchParams(tokenQuery);
		query.set(TOKEN_STATUS_QUERY_PARAM, tokenStatus);
		return withQuery(normalizedBasePath, query);
	};
	const activityKindHref = (kind: ActivityFeedFilterKind): string => {
		const query = new URLSearchParams(activityQuery);
		query.set(ACTIVITY_KIND_QUERY_PARAM, kind);
		return withQuery(joinPath(normalizedBasePath, 'activity'), query);
	};
	const biddingViewHref = (view: CollectionBiddingViewMode): string | null => {
		if (view === 'bid_book' && !showBiddingOffers) return null;
		if (view === 'jobs' && !showBiddingJobs) return null;
		const query = new URLSearchParams(biddingQuery);
		if (view === 'bid_book') {
			query.delete(BIDDING_VIEW_QUERY_PARAM);
		} else {
			query.set(BIDDING_VIEW_QUERY_PARAM, view);
		}
		return withQuery(joinPath(normalizedBasePath, 'bidding'), query);
	};

	const holdersQuery = new URLSearchParams();
	appendMediaModeParam(holdersQuery, mediaMode);

	return {
		basePath: normalizedBasePath,
		showBiddingOffers,
		showBiddingJobs,
		queries: {
			tokens: tokenQuery,
			activities: activityQuery,
			bidding: biddingQuery
		},
		hrefs: {
			asks: tokenStatusHref('listed'),
			offers: biddingViewHref('bid_book'),
			tokens: tokenStatusHref('all'),
			bidding: biddingViewHref('jobs'),
			holders: withQuery(joinPath(normalizedBasePath, 'holders'), holdersQuery),
			customization: buildCollectionCustomizationHref({
				basePath: normalizedBasePath,
				selectedTraits: state.selectedTraits,
				selectedTraitRanges: state.selectedTraitRanges,
				mediaMode
			}),
			tokenStatus: tokenStatusHref,
			activityKind: activityKindHref,
			biddingView: biddingViewHref
		}
	};
}

// Applies collection-level numeric navigation after modal/text-input guards in page key handlers.
export function handleCollectionSectionShortcut(
	event: KeyboardEvent,
	navigation: CollectionNavigation
): boolean {
	const href = resolveCollectionSectionShortcutHref(event, navigation);
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
	navigation: CollectionNavigation
): string | null {
	if (event.defaultPrevented) return null;
	if (event.metaKey || event.ctrlKey || event.altKey) return null;
	if (isKeyboardTextEntryTarget(event.target)) return null;

	switch (event.key) {
		case '1':
			return navigation.hrefs.asks;
		case '2':
			return navigation.hrefs.offers;
		case '3':
			return navigation.hrefs.tokens;
		case '4':
			return navigation.hrefs.bidding;
		default:
			return null;
	}
}
