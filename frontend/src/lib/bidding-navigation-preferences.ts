import { browser } from '$app/environment';
import {
	BID_SCOPE_QUERY_PARAM,
	COLLECTION_BIDDING_BID_SCOPE_FILTERS,
	type CollectionBiddingBidScopeFilter
} from '$lib/bidding-query';
import {
	applyQueryControlPreferenceToQuery,
	readQueryControlPreference,
	type QueryControlPreferenceDefinitions,
	writeQueryControlPreference
} from '$lib/query-control-preferences';
import { LOCAL_STORAGE_KEYS } from '$lib/local-storage-keys';

export type CollectionBiddingNavigationPreference = {
	bidScope: CollectionBiddingBidScopeFilter;
};

const BIDDING_NAVIGATION_DEFINITIONS = {
	bidScope: {
		param: BID_SCOPE_QUERY_PARAM,
		values: COLLECTION_BIDDING_BID_SCOPE_FILTERS
	}
} satisfies QueryControlPreferenceDefinitions<CollectionBiddingNavigationPreference>;

export function readCollectionBiddingNavigationPreference(): Partial<CollectionBiddingNavigationPreference> | null {
	return readQueryControlPreference({
		storageKey: LOCAL_STORAGE_KEYS.collectionBiddingNavigationPreferences,
		definitions: BIDDING_NAVIGATION_DEFINITIONS
	});
}

export function writeCollectionBiddingNavigationPreference(
	preference: CollectionBiddingNavigationPreference
): void {
	writeQueryControlPreference({
		storageKey: LOCAL_STORAGE_KEYS.collectionBiddingNavigationPreferences,
		definitions: BIDDING_NAVIGATION_DEFINITIONS,
		preference
	});
}

export function applyCollectionBiddingNavigationPreferenceToQuery(
	query: URLSearchParams,
	preference: Partial<CollectionBiddingNavigationPreference> | null
): URLSearchParams {
	return applyQueryControlPreferenceToQuery({
		query,
		definitions: BIDDING_NAVIGATION_DEFINITIONS,
		preference
	});
}

export function resolvePreferredCollectionBiddingNavigationHref(url: URL): string | null {
	if (!browser) return null;
	const preferredQuery = applyCollectionBiddingNavigationPreferenceToQuery(
		url.searchParams,
		readCollectionBiddingNavigationPreference()
	);
	const preferredQueryString = preferredQuery.toString();
	if (preferredQueryString === url.searchParams.toString()) return null;
	return `${url.pathname}${preferredQueryString ? `?${preferredQueryString}` : ''}`;
}
