import { browser } from '$app/environment';
import { bidScopeSupportsOwnStateFilter } from '@artgod/shared/trading/bid-book-own-state';
import {
	COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER,
	COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS,
	COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS
} from '@artgod/shared/types';
import {
	BID_SCOPE_QUERY_PARAM,
	BID_BOOK_OWNERSHIP_QUERY_PARAM,
	COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER,
	COLLECTION_BIDDING_BID_SCOPE_FILTERS,
	buildCollectionBiddingQuery,
	buildCollectionBiddingHref,
	type CollectionBiddingQueryParams,
	type CollectionBiddingBidScopeFilter,
	type CollectionBiddingBidBookOwnershipFilter,
	type CollectionBiddingBidBookOwnStateFilter
} from '$lib/bidding-query';
import {
	applyQueryControlPreferenceToQuery,
	readQueryControlPreference,
	type QueryControlPreferenceDefinitions,
	writeQueryControlPreference
} from '$lib/query-control-preferences';
import { LOCAL_STORAGE_KEYS } from '$lib/local-storage-keys';
import { IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT } from '$lib/runtime/public-deployment';

export type CollectionBiddingNavigationPreference = {
	bidScope: CollectionBiddingBidScopeFilter;
	ownershipFilter?: CollectionBiddingBidBookOwnershipFilter | null;
	ownStateFilter?: CollectionBiddingBidBookOwnStateFilter | null;
};

const BIDDING_NAVIGATION_DEFINITIONS = {
	bidScope: {
		param: BID_SCOPE_QUERY_PARAM,
		values: COLLECTION_BIDDING_BID_SCOPE_FILTERS
	},
	ownershipFilter: {
		param: BID_BOOK_OWNERSHIP_QUERY_PARAM,
		values: [null, COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own]
	},
	ownStateFilter: {
		param: COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState,
		values: [null, ...COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTERS]
	}
} satisfies QueryControlPreferenceDefinitions<CollectionBiddingNavigationPreference>;

export function readCollectionBiddingNavigationPreference(): Partial<CollectionBiddingNavigationPreference> | null {
	return readQueryControlPreference({
		storageKey: LOCAL_STORAGE_KEYS.collectionBiddingNavigationPreferences,
		definitions: BIDDING_NAVIGATION_DEFINITIONS
	});
}

// An unavailable control leaves its last selection intact. An applicable
// control's null value is an explicit reset and replaces the remembered value.
function ownStateNavigationPreference(
	current: Pick<CollectionBiddingNavigationPreference, 'bidScope' | 'ownStateFilter'>,
	previous: Partial<CollectionBiddingNavigationPreference> | null
): CollectionBiddingBidBookOwnStateFilter | null | undefined {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) return undefined;
	return bidScopeSupportsOwnStateFilter(current.bidScope)
		? current.ownStateFilter
		: previous?.ownStateFilter;
}

// Return the remembered model as well as persisting it, so an open view retains
// its navigation context even when browser storage is unavailable.
export function writeCollectionBiddingNavigationPreference(
	current: CollectionBiddingNavigationPreference,
	previous: Partial<CollectionBiddingNavigationPreference> | null = readCollectionBiddingNavigationPreference()
): CollectionBiddingNavigationPreference {
	const preference = IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT
		? { bidScope: current.bidScope }
		: {
				bidScope: current.bidScope,
				ownershipFilter: current.ownershipFilter,
				ownStateFilter: ownStateNavigationPreference(current, previous)
			};
	writeQueryControlPreference({
		storageKey: LOCAL_STORAGE_KEYS.collectionBiddingNavigationPreferences,
		definitions: BIDDING_NAVIGATION_DEFINITIONS,
		preference
	});
	return preference;
}

// Scope buttons resume the state selection when entering a supported view.
// The canonical query builder omits it from collection-scoped URLs and reads.
export function buildCollectionBiddingScopeHref(
	current: CollectionBiddingQueryParams & {
		basePath: string;
		bidScope: CollectionBiddingBidScopeFilter;
	},
	nextScope: CollectionBiddingBidScopeFilter,
	preference: Partial<CollectionBiddingNavigationPreference> | null = readCollectionBiddingNavigationPreference()
): string {
	return buildCollectionBiddingHref(current, {
		bidScope: nextScope,
		ownershipFilter: IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT ? null : current.ownershipFilter,
		ownStateFilter: ownStateNavigationPreference(current, preference)
	});
}

// Primary Offers navigation uses private defaults only when no explicit or
// remembered choice exists. Null is an intentional All-bids or reset selection.
export function buildCollectionBiddingNavigationQuery(
	params: CollectionBiddingQueryParams,
	preference: Partial<CollectionBiddingNavigationPreference> | null = readCollectionBiddingNavigationPreference()
): URLSearchParams {
	return buildCollectionBiddingQuery({
		...params,
		bidScope: params.bidScope ?? preference?.bidScope,
		ownershipFilter: IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT
			? null
			: params.ownershipFilter !== undefined
				? params.ownershipFilter
				: preference?.ownershipFilter !== undefined
					? preference.ownershipFilter
					: COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own,
		ownStateFilter: IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT
			? null
			: params.ownStateFilter !== undefined
				? params.ownStateFilter
				: preference?.ownStateFilter !== undefined
					? preference.ownStateFilter
					: COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active
	});
}

// Route loads restore scope only. Missing ownership/status URL parameters can
// represent an explicit All-bids or reset action and must stay unfiltered.
export function applyCollectionBiddingNavigationPreferenceToQuery(
	query: URLSearchParams,
	preference: Partial<CollectionBiddingNavigationPreference> | null
): URLSearchParams {
	return applyQueryControlPreferenceToQuery({
		query,
		definitions: { bidScope: BIDDING_NAVIGATION_DEFINITIONS.bidScope },
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
