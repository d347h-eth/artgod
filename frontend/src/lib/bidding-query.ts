import { PAGINATION_QUERY_PARAMS } from '@artgod/shared/config/pagination';
import {
	COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS,
	COLLECTION_BIDDING_BID_SCOPE_FILTER,
	COLLECTION_BIDDING_BID_SCOPE_FILTERS,
	COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
	type CollectionBiddingBidScopeFilter,
	type CollectionBiddingTraitFilterJoinMode
} from '@artgod/shared/types';
import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';
import { appendCollectionMediaParams, type CollectionMediaPreferenceInput } from '$lib/media-mode';
import { joinPath, withQuery } from '$lib/route-paths';
import { appendTraitParams, appendTraitRangeParams } from '$lib/trait-filters';

export {
	COLLECTION_BIDDING_BID_SCOPE_FILTER,
	COLLECTION_BIDDING_BID_SCOPE_FILTERS,
	COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE
};
export type { CollectionBiddingBidScopeFilter, CollectionBiddingTraitFilterJoinMode };

export const BID_SCOPE_QUERY_PARAM = COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.BidScope;
export const BID_BOOK_MAKER_QUERY_PARAM = COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.Maker;
const SHOW_MUTED_BID_BOOK_QUERY_PARAM = COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.ShowMuted;

type OrderedQueryControlValues<T extends string> = readonly [T, ...T[]];

export function buildCollectionBiddingQuery(params: {
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	bidScope?: CollectionBiddingBidScopeFilter;
	traitJoinMode?: CollectionBiddingTraitFilterJoinMode;
	mediaMode?: string | null;
	mediaPreference?: CollectionMediaPreferenceInput;
	maker?: string | null;
	showMuted?: boolean;
	limit?: number | null;
	cursor?: string | null;
}): URLSearchParams {
	const query = new URLSearchParams();
	appendCollectionMediaParams(query, {
		mediaMode: params.mediaMode ?? null,
		mediaPreference: params.mediaPreference ?? null
	});
	if (params.bidScope && params.bidScope !== COLLECTION_BIDDING_BID_SCOPE_FILTER.Token) {
		query.set(BID_SCOPE_QUERY_PARAM, params.bidScope);
	}
	if (
		params.bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits &&
		params.traitJoinMode &&
		params.traitJoinMode !== COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or
	) {
		query.set(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.TraitJoin, params.traitJoinMode);
	}
	if (params.showMuted) {
		query.set(SHOW_MUTED_BID_BOOK_QUERY_PARAM, 'true');
	}
	if (params.maker?.trim()) {
		query.set(BID_BOOK_MAKER_QUERY_PARAM, params.maker.trim());
	}
	if (params.limit && Number.isInteger(params.limit) && params.limit > 0) {
		query.set(PAGINATION_QUERY_PARAMS.Limit, String(params.limit));
	}
	if (params.cursor?.trim()) {
		query.set(PAGINATION_QUERY_PARAMS.Cursor, params.cursor.trim());
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
	mediaMode?: string | null;
	mediaPreference?: CollectionMediaPreferenceInput;
	maker?: string | null;
	showMuted?: boolean;
	limit?: number | null;
	cursor?: string | null;
}): string {
	return withQuery(joinPath(params.basePath, 'bidding'), buildCollectionBiddingQuery(params));
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

export function parseCollectionBiddingTraitFilterJoinMode(
	searchParams: URLSearchParams
): CollectionBiddingTraitFilterJoinMode {
	return searchParams.get(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.TraitJoin) ===
		COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And
		? COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And
		: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or;
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
