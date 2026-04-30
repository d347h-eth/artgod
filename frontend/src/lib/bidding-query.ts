import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';
import { appendMediaModeParam } from '$lib/media-mode';
import { joinPath, withQuery } from '$lib/route-paths';
import { appendTraitParams, appendTraitRangeParams } from '$lib/trait-filters';

export type CollectionBiddingBidScopeFilter = 'collection' | 'traits';

export function buildCollectionBiddingQuery(params: {
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	bidScope?: CollectionBiddingBidScopeFilter;
	mediaMode?: string | null;
}): URLSearchParams {
	const query = new URLSearchParams();
	appendMediaModeParam(query, params.mediaMode ?? null);
	if (params.bidScope && params.bidScope !== 'collection') {
		query.set('bid_scope', params.bidScope);
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
	mediaMode?: string | null;
}): string {
	return withQuery(
		joinPath(params.basePath, 'bidding'),
		buildCollectionBiddingQuery(params)
	);
}
