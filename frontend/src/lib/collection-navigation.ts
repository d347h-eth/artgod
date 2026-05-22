import { goto } from '$app/navigation';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { ActivityFeedFilterKind } from '@artgod/shared/types';
import {
	ACTIVITY_EXTENSION_EVENT_QUERY_PARAM,
	ACTIVITY_KIND_QUERY_PARAM,
	formatActivityExtensionEventRef,
	buildCollectionActivityQuery,
	COLLECTION_ACTIVITY_FILTER_KINDS
} from '$lib/activity-query';
import type {
	ApiActivityExtensionEventFeed,
	ApiActivityExtensionEventRef,
	ApiTokenAttribute,
	ApiTraitRangeFilter
} from '$lib/api-types';
import {
	BIDDING_VIEW_QUERY_PARAM,
	COLLECTION_BIDDING_VIEW_MODE,
	buildCollectionBiddingQuery,
	type CollectionBiddingBidScopeFilter,
	type CollectionBiddingTraitFilterJoinMode,
	type CollectionBiddingViewMode
} from '$lib/bidding-query';
import { isKeyboardTextEntryTarget } from '$lib/components/keyboard-targets';
import { buildCollectionCustomizationHref } from '$lib/customization-query';
import { appendMediaModeParam } from '$lib/media-mode';
import { joinPath, normalizeBasePath, withQuery } from '$lib/route-paths';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	publicCollectionBlockspacePath
} from '$lib/runtime/public-deployment';
import { TOKEN_STATUS_QUERY_PARAM, type CollectionTokenStatus } from '$lib/token-browser-query';
import { buildCollectionTokenNavigationQuery } from '$lib/token-browser-navigation-preferences';

export type CollectionNavigationState = {
	basePath: string;
	mediaMode?: string | null;
	activityEventFeeds?: ApiActivityExtensionEventFeed[];
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	token?: {
		limit?: number;
		displayMode?: 'grid' | 'table';
	};
	activity?: {
		limit?: number;
		kind?: ActivityFeedFilterKind;
		extensionEvent?: ApiActivityExtensionEventRef | null;
	};
	bidding?: {
		enabled?: boolean;
		showOffers?: boolean;
		showJobs?: boolean;
		bidScope?: CollectionBiddingBidScopeFilter;
		traitJoinMode?: CollectionBiddingTraitFilterJoinMode;
		viewMode?: CollectionBiddingViewMode;
		maker?: string | null;
		showMuted?: boolean;
	};
	blockspace?: {
		enabled?: boolean;
	};
};

export type CollectionNavigation = {
	basePath: string;
	showBiddingOffers: boolean;
	showBiddingJobs: boolean;
	showBlockspace: boolean;
	activityEventFeeds: ApiActivityExtensionEventFeed[];
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
		blockspace: string | null;
		customization: string;
		tokenStatus: (tokenStatus: CollectionTokenStatus) => string;
		activityKind: (kind: ActivityFeedFilterKind) => string;
		activityExtensionEvent: (event: ApiActivityExtensionEventRef) => string;
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
	const activityExtensionEvent = state.activity?.extensionEvent ?? null;
	const activityEventFeeds = state.activityEventFeeds ?? [];
	const defaultBiddingVisibility = state.bidding?.enabled ?? true;
	const showBiddingOffers = state.bidding?.showOffers ?? defaultBiddingVisibility;
	const showBiddingJobs = state.bidding?.showJobs ?? defaultBiddingVisibility;
	const blockspaceHref = resolveBlockspaceHref(normalizedBasePath);
	const showBlockspace = (state.blockspace?.enabled ?? true) && blockspaceHref !== null;

	const tokenQuery = buildCollectionTokenNavigationQuery({
		limit: tokenLimit,
		displayMode: tokenDisplayMode,
		selectedTraits: state.selectedTraits,
		selectedTraitRanges: state.selectedTraitRanges,
		mediaMode
	});
	const activityQuery = buildCollectionActivityQuery({
		limit: activityLimit,
		kind: activityExtensionEvent ? null : activityKind,
		extensionEvent: activityExtensionEvent,
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
		maker: state.bidding?.maker,
		showMuted: state.bidding?.showMuted
	});

	const tokenStatusHref = (tokenStatus: CollectionTokenStatus): string => {
		const query = new URLSearchParams(tokenQuery);
		query.set(TOKEN_STATUS_QUERY_PARAM, tokenStatus);
		return withQuery(normalizedBasePath, query);
	};
	const activityKindHref = (kind: ActivityFeedFilterKind): string => {
		const query = new URLSearchParams(activityQuery);
		query.delete(ACTIVITY_EXTENSION_EVENT_QUERY_PARAM);
		query.set(ACTIVITY_KIND_QUERY_PARAM, kind);
		return withQuery(joinPath(normalizedBasePath, 'activity'), query);
	};
	const activityExtensionEventHref = (event: ApiActivityExtensionEventRef): string => {
		const query = new URLSearchParams(activityQuery);
		query.delete(ACTIVITY_KIND_QUERY_PARAM);
		query.set(ACTIVITY_EXTENSION_EVENT_QUERY_PARAM, formatActivityExtensionEventRef(event));
		return withQuery(joinPath(normalizedBasePath, 'activity'), query);
	};
	const biddingViewHref = (view: CollectionBiddingViewMode): string | null => {
		if (view === COLLECTION_BIDDING_VIEW_MODE.BidBook && !showBiddingOffers) return null;
		if (view === COLLECTION_BIDDING_VIEW_MODE.Jobs && !showBiddingJobs) return null;
		const query = new URLSearchParams(biddingQuery);
		if (view === COLLECTION_BIDDING_VIEW_MODE.BidBook) {
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
		showBlockspace,
		activityEventFeeds,
		queries: {
			tokens: tokenQuery,
			activities: activityQuery,
			bidding: biddingQuery
		},
		hrefs: {
			asks: tokenStatusHref('listed'),
			offers: biddingViewHref(COLLECTION_BIDDING_VIEW_MODE.BidBook),
			tokens: tokenStatusHref('all'),
			bidding: biddingViewHref(COLLECTION_BIDDING_VIEW_MODE.Jobs),
			holders: withQuery(joinPath(normalizedBasePath, 'holders'), holdersQuery),
			blockspace: showBlockspace ? blockspaceHref : null,
			customization: buildCollectionCustomizationHref({
				basePath: normalizedBasePath,
				selectedTraits: state.selectedTraits,
				selectedTraitRanges: state.selectedTraitRanges,
				mediaMode
			}),
			tokenStatus: tokenStatusHref,
			activityKind: activityKindHref,
			activityExtensionEvent: activityExtensionEventHref,
			biddingView: biddingViewHref
		}
	};
}

function resolveBlockspaceHref(basePath: string): string | null {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		return publicCollectionBlockspacePath();
	}

	const [chainRef, collectionRef] = basePath.split('/').filter(Boolean);
	if (!chainRef || !collectionRef) return null;
	const query = new URLSearchParams();
	query.set('collection', collectionRef);
	return withQuery(`/${encodeURIComponent(chainRef)}/sync-backfill`, query);
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
	if (isKeyboardTextEntryTarget(event.target, { allowCheckboxAndRadio: true })) return null;

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
