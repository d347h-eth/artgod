import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';
import { appendMediaModeParam } from '$lib/media-mode';
import { joinPath, withQuery } from '$lib/route-paths';
import { appendTraitParams, appendTraitRangeParams } from '$lib/trait-filters';

export type CollectionBiddingBidScopeFilter = 'collection' | 'traits';
export type CollectionBiddingTraitFilterJoinMode = 'or' | 'and';
export type CollectionBiddingViewMode = 'bid_book' | 'jobs';

const BIDDING_VIEW_QUERY_PARAM = 'bidding_view';
const SHOW_MUTED_BID_BOOK_QUERY_PARAM = 'show_muted';

export function buildCollectionBiddingQuery(params: {
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	bidScope?: CollectionBiddingBidScopeFilter;
	traitJoinMode?: CollectionBiddingTraitFilterJoinMode;
	viewMode?: CollectionBiddingViewMode;
	mediaMode?: string | null;
	showMuted?: boolean;
}): URLSearchParams {
	const query = new URLSearchParams();
	appendMediaModeParam(query, params.mediaMode ?? null);
	if (params.viewMode && params.viewMode !== 'bid_book') {
		query.set(BIDDING_VIEW_QUERY_PARAM, params.viewMode);
	}
	if (params.bidScope && params.bidScope !== 'collection') {
		query.set('bid_scope', params.bidScope);
	}
	if (params.traitJoinMode && params.traitJoinMode !== 'or') {
		query.set('trait_join', params.traitJoinMode);
	}
	if (params.showMuted) {
		query.set(SHOW_MUTED_BID_BOOK_QUERY_PARAM, 'true');
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
	showMuted?: boolean;
}): string {
	return withQuery(
		joinPath(params.basePath, 'bidding'),
		buildCollectionBiddingQuery(params)
	);
}

export function parseShowMutedBidBook(searchParams: URLSearchParams): boolean {
	return searchParams.get(SHOW_MUTED_BID_BOOK_QUERY_PARAM) === 'true';
}

export function parseCollectionBiddingView(
	searchParams: URLSearchParams
): CollectionBiddingViewMode {
	return searchParams.get(BIDDING_VIEW_QUERY_PARAM) === 'jobs' ? 'jobs' : 'bid_book';
}

export function parseCollectionBiddingTraitFilterJoinMode(
	searchParams: URLSearchParams
): CollectionBiddingTraitFilterJoinMode {
	return searchParams.get('trait_join') === 'and' ? 'and' : 'or';
}
