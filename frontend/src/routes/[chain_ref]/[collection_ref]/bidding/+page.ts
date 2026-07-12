import { error, redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { COLLECTION_MEDIA_MODE_OPTIONS, COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import {
	BackendApiError,
	getCollectionBiddingBidBook,
	getCollectionBiddingPriceTiers,
	getRuntimeConfig
} from '$lib/backend-api';
import { emptyBiddingBidBook, emptyBiddingTokenOfferCardsPage } from '$lib/bidding-empty-state';
import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';
import { resolvePreferredCollectionBiddingNavigationHref } from '$lib/bidding-navigation-preferences';
import {
	parseCollectionBiddingBidScopeFilter,
	parseCollectionBiddingTraitFilterJoinMode,
	parseBidBookMakerFilter,
	parseShowMutedBidBook
} from '$lib/bidding-query';
import { MEDIA_MODE_QUERY_PARAM, normalizeMediaMode } from '$lib/media-mode';
import { withQuery } from '$lib/route-paths';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE,
	matchesPublicCollectionRoute,
	publicCollectionBiddingPath
} from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import { parseSelectedTraitRanges, parseSelectedTraits } from '$lib/trait-filters';

export const load: PageLoad = async ({ fetch, params, url }) => {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		if (!PUBLIC_COLLECTION_SCOPE) {
			throw error(500, 'Public collection scope is not configured');
		}
		if (!matchesPublicCollectionRoute(params.chain_ref, params.collection_ref)) {
			throw error(404, 'Not found');
		}
		throw redirect(307, withQuery(publicCollectionBiddingPath(), url.searchParams));
	}

	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			chain: null,
			collection: null,
			biddingSettings: defaultBiddingCollectionSettings(),
			priceTiers: [],
			bidBook: emptyBiddingBidBook(),
			tokenOfferCards: emptyBiddingTokenOfferCardsPage(),
			facets: [],
			media: {
				selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
				defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
				availableModes: [COLLECTION_MEDIA_MODE_OPTIONS.Snapshot],
				preference: null
			},
			basePath: '/',
			selectedTraits: parseSelectedTraits(url.searchParams),
			selectedTraitRanges: parseSelectedTraitRanges(url.searchParams),
			bidScope: parseCollectionBiddingBidScopeFilter(url.searchParams),
			traitJoinMode: parseCollectionBiddingTraitFilterJoinMode(url.searchParams),
			showMuted: parseShowMutedBidBook(url.searchParams),
			makerFilter: parseBidBookMakerFilter(url.searchParams),
			mediaMode: normalizeMediaMode(url.searchParams.get(MEDIA_MODE_QUERY_PARAM)),
			requestCursor: url.searchParams.get('cursor')
		};
	}

	const preferredHref = resolvePreferredCollectionBiddingNavigationHref(url);
	if (preferredHref) {
		throw redirect(307, preferredHref);
	}

	try {
		// Load the source-selected bid book and local bidding settings for this collection.
		const [bidBookResponse, priceTiersResponse, runtimeConfigResponse] = await Promise.all([
			getCollectionBiddingBidBook(fetch, params.chain_ref, params.collection_ref, url.searchParams),
			getCollectionBiddingPriceTiers(fetch, params.chain_ref, params.collection_ref),
			getRuntimeConfig(fetch)
		]);
		return {
			chain: bidBookResponse.chain,
			collection: bidBookResponse.collection,
			biddingSettings: priceTiersResponse.settings,
			priceTiers: priceTiersResponse.tiers,
			trustOpenSeaSignedZoneTraitOffers:
				runtimeConfigResponse.bidding.trustOpenSeaSignedZoneTraitOffers,
			bidBookLiveRefreshConfig: runtimeConfigResponse.bidding.bidBookLiveRefresh,
			blockExplorer: runtimeConfigResponse.blockExplorer,
			bidBook: bidBookResponse.bidBook,
			tokenOfferCards: bidBookResponse.tokenOfferCards,
			facets: bidBookResponse.traits.facets,
			media: bidBookResponse.media,
			basePath: `/${bidBookResponse.chain.slug}/${bidBookResponse.collection.slug}`,
			selectedTraits: bidBookResponse.traits.selected,
			selectedTraitRanges: bidBookResponse.traits.selectedRanges,
			bidScope: bidBookResponse.scopeFilter,
			traitJoinMode: parseCollectionBiddingTraitFilterJoinMode(url.searchParams),
			showMuted: parseShowMutedBidBook(url.searchParams),
			makerFilter: parseBidBookMakerFilter(url.searchParams),
			mediaMode: normalizeMediaMode(url.searchParams.get(MEDIA_MODE_QUERY_PARAM)),
			requestCursor: url.searchParams.get('cursor')
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
