import { browser } from '$app/environment';
import {
	BID_SCOPE_QUERY_PARAM,
	BIDDING_VIEW_QUERY_PARAM,
	COLLECTION_BIDDING_BID_SCOPE_FILTERS,
	COLLECTION_BIDDING_VIEW_MODES,
	type CollectionBiddingBidScopeFilter,
	type CollectionBiddingViewMode
} from '$lib/bidding-query';
import {
	applyQueryControlPreferenceToQuery,
	readScopedQueryControlPreference,
	writeScopedQueryControlPreference,
	type QueryControlPreferenceDefinitions
} from '$lib/query-control-preferences';
import { joinPath, withQuery } from '$lib/route-paths';

const STORAGE_KEY = 'artgod.collectionBidding.navigationPreferences.v1';

export type CollectionBiddingNavigationPreference = {
	biddingView: CollectionBiddingViewMode;
	bidScope: CollectionBiddingBidScopeFilter;
};

const BIDDING_NAVIGATION_DEFINITIONS = {
	biddingView: {
		param: BIDDING_VIEW_QUERY_PARAM,
		values: COLLECTION_BIDDING_VIEW_MODES
	},
	bidScope: {
		param: BID_SCOPE_QUERY_PARAM,
		values: COLLECTION_BIDDING_BID_SCOPE_FILTERS
	}
} satisfies QueryControlPreferenceDefinitions<CollectionBiddingNavigationPreference>;

export function readCollectionBiddingNavigationPreference(
	collectionPath: string
): Partial<CollectionBiddingNavigationPreference> | null {
	return readScopedQueryControlPreference({
		storageKey: STORAGE_KEY,
		scopePath: collectionPath,
		definitions: BIDDING_NAVIGATION_DEFINITIONS
	});
}

export function writeCollectionBiddingNavigationPreference(
	collectionPath: string,
	preference: CollectionBiddingNavigationPreference
): void {
	writeScopedQueryControlPreference({
		storageKey: STORAGE_KEY,
		scopePath: collectionPath,
		definitions: BIDDING_NAVIGATION_DEFINITIONS,
		preference
	});
}

export function preferredCollectionBiddingHref(params: {
	basePath: string;
	query: URLSearchParams;
}): string {
	return withQuery(
		joinPath(params.basePath, 'bidding'),
		applyCollectionBiddingNavigationPreferenceToQuery(
			params.basePath,
			params.query,
			browser ? readCollectionBiddingNavigationPreference(params.basePath) : null
		)
	);
}

export function applyCollectionBiddingNavigationPreferenceToQuery(
	basePath: string,
	query: URLSearchParams,
	preference: Partial<CollectionBiddingNavigationPreference> | null
): URLSearchParams {
	return applyQueryControlPreferenceToQuery({
		query,
		definitions: BIDDING_NAVIGATION_DEFINITIONS,
		preference: basePath.trim() ? preference : null
	});
}
