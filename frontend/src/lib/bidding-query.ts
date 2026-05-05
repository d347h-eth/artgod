import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';
import { appendMediaModeParam } from '$lib/media-mode';
import { joinPath, withQuery } from '$lib/route-paths';
import { appendTraitParams, appendTraitRangeParams } from '$lib/trait-filters';

export const COLLECTION_BIDDING_BID_SCOPE_FILTERS = [
	'token',
	'traits',
	'collection'
] as const;
export const COLLECTION_BIDDING_VIEW_MODES = [
	'bid_book',
	'jobs'
] as const;

export type CollectionBiddingBidScopeFilter =
	(typeof COLLECTION_BIDDING_BID_SCOPE_FILTERS)[number];
export type CollectionBiddingTraitFilterJoinMode = 'or' | 'and';
export type CollectionBiddingViewMode = (typeof COLLECTION_BIDDING_VIEW_MODES)[number];

export const BID_SCOPE_QUERY_PARAM = 'bid_scope';
export const BIDDING_VIEW_QUERY_PARAM = 'bidding_view';
export const BID_BOOK_MAKER_QUERY_PARAM = 'maker';
const SHOW_MUTED_BID_BOOK_QUERY_PARAM = 'show_muted';

type OrderedQueryControlValues<T extends string> = readonly [T, ...T[]];

export function buildCollectionBiddingQuery(params: {
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	bidScope?: CollectionBiddingBidScopeFilter;
	traitJoinMode?: CollectionBiddingTraitFilterJoinMode;
	viewMode?: CollectionBiddingViewMode;
	mediaMode?: string | null;
	maker?: string | null;
	showMuted?: boolean;
	limit?: number | null;
	cursor?: string | null;
}): URLSearchParams {
	const query = new URLSearchParams();
	appendMediaModeParam(query, params.mediaMode ?? null);
	if (params.viewMode && params.viewMode !== 'bid_book') {
		query.set(BIDDING_VIEW_QUERY_PARAM, params.viewMode);
	}
	if (params.bidScope && params.bidScope !== 'token') {
		query.set(BID_SCOPE_QUERY_PARAM, params.bidScope);
	}
	if (params.bidScope === 'traits' && params.traitJoinMode && params.traitJoinMode !== 'or') {
		query.set('trait_join', params.traitJoinMode);
	}
	if (params.showMuted) {
		query.set(SHOW_MUTED_BID_BOOK_QUERY_PARAM, 'true');
	}
	if (params.maker?.trim()) {
		query.set(BID_BOOK_MAKER_QUERY_PARAM, params.maker.trim());
	}
	if (params.limit && Number.isInteger(params.limit) && params.limit > 0) {
		query.set('limit', String(params.limit));
	}
	if (params.cursor?.trim()) {
		query.set('cursor', params.cursor.trim());
	}
	appendTraitParams(query, params.selectedTraits);
	appendTraitRangeParams(query, params.selectedTraitRanges);
	return query;
}

export function buildCollectionBiddingHref(params: {
	basePath: string;
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	bidScope?: CollectionBiddingBidScopeFilter;
	traitJoinMode?: CollectionBiddingTraitFilterJoinMode;
	viewMode?: CollectionBiddingViewMode;
	mediaMode?: string | null;
	maker?: string | null;
	showMuted?: boolean;
	limit?: number | null;
	cursor?: string | null;
}): string {
	return withQuery(
		joinPath(params.basePath, 'bidding'),
		buildCollectionBiddingQuery(params)
	);
}

export function parseShowMutedBidBook(searchParams: URLSearchParams): boolean {
	return searchParams.get(SHOW_MUTED_BID_BOOK_QUERY_PARAM) === 'true';
}

export function parseBidBookMakerFilter(searchParams: URLSearchParams): string | null {
	const value = searchParams.get(BID_BOOK_MAKER_QUERY_PARAM)?.trim();
	return value ? value : null;
}

export function parseCollectionBiddingBidScopeFilter(
	searchParams: URLSearchParams
): CollectionBiddingBidScopeFilter {
	return parseOrderedQueryControl(
		COLLECTION_BIDDING_BID_SCOPE_FILTERS,
		searchParams.get(BID_SCOPE_QUERY_PARAM)
	);
}

export function parseCollectionBiddingView(
	searchParams: URLSearchParams
): CollectionBiddingViewMode {
	return parseOrderedQueryControl(
		COLLECTION_BIDDING_VIEW_MODES,
		searchParams.get(BIDDING_VIEW_QUERY_PARAM)
	);
}

export function parseCollectionBiddingTraitFilterJoinMode(
	searchParams: URLSearchParams
): CollectionBiddingTraitFilterJoinMode {
	return searchParams.get('trait_join') === 'and' ? 'and' : 'or';
}

export function nextCollectionBiddingBidScopeFilter(
	current: CollectionBiddingBidScopeFilter
): CollectionBiddingBidScopeFilter {
	return nextOrderedQueryControl(COLLECTION_BIDDING_BID_SCOPE_FILTERS, current);
}

function parseOrderedQueryControl<T extends string>(
	values: OrderedQueryControlValues<T>,
	raw: string | null
): T {
	return values.includes(raw as T) ? (raw as T) : values[0];
}

function nextOrderedQueryControl<T extends string>(
	values: OrderedQueryControlValues<T>,
	current: T
): T {
	const currentIndex = values.indexOf(current);
	if (currentIndex < 0) return values[0];
	return values[(currentIndex + 1) % values.length];
}
