import { error, redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import {
	BackendApiError,
	getCollectionBiddingBidBook,
	getRuntimeConfig
} from '$lib/backend-api';
import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';
import { resolvePreferredCollectionBiddingNavigationHref } from '$lib/bidding-navigation-preferences';
import {
	parseBidBookMakerFilter,
	parseCollectionBiddingTraitFilterJoinMode,
	parseShowMutedBidBook
} from '$lib/bidding-query';
import { normalizeMediaMode } from '$lib/media-mode';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE,
	publicCollectionTokensPath
} from '$lib/runtime/public-deployment';

export const load: PageLoad = async ({ fetch, url }) => {
	if (!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT || !PUBLIC_COLLECTION_SCOPE) {
		throw error(404, 'Not found');
	}

	const preferredHref = resolvePreferredCollectionBiddingNavigationHref(url);
	if (preferredHref) {
		throw redirect(307, preferredHref);
	}

	const mediaMode = normalizeMediaMode(url.searchParams.get('media_mode'));

	try {
		// Load bid-book data without exposing bidding job management.
		const [bidBookResponse, runtimeConfigResponse] = await Promise.all([
			getCollectionBiddingBidBook(
				fetch,
				PUBLIC_COLLECTION_SCOPE.chainRef,
				PUBLIC_COLLECTION_SCOPE.collectionRef,
				url.searchParams
			),
			getRuntimeConfig(fetch)
		]);
		return {
			chain: bidBookResponse.chain,
			collection: bidBookResponse.collection,
			biddingSettings: defaultBiddingCollectionSettings(),
			priceTiers: [],
			bidBookLiveRefreshConfig: runtimeConfigResponse.bidding.bidBookLiveRefresh,
			bidBook: bidBookResponse.bidBook,
			tokenOfferCards: bidBookResponse.tokenOfferCards,
			facets: bidBookResponse.traits.facets,
			media: bidBookResponse.media,
			basePath: publicCollectionTokensPath(),
			selectedTraits: bidBookResponse.traits.selected,
			selectedTraitRanges: bidBookResponse.traits.selectedRanges,
			bidScope: bidBookResponse.scopeFilter,
			traitJoinMode: parseCollectionBiddingTraitFilterJoinMode(url.searchParams),
			showMuted: parseShowMutedBidBook(url.searchParams),
			makerFilter: parseBidBookMakerFilter(url.searchParams),
			mediaMode,
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
