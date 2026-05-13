import { error, redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import {
	BackendApiError,
	getCollectionBiddingBidBook,
	getCollectionDetail
} from '$lib/backend-api';
import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';
import { resolvePreferredCollectionBiddingNavigationHref } from '$lib/bidding-navigation-preferences';
import {
	BIDDING_VIEW_QUERY_PARAM,
	parseBidBookMakerFilter,
	parseCollectionBiddingTraitFilterJoinMode,
	parseCollectionBiddingView,
	parseShowMutedBidBook
} from '$lib/bidding-query';
import { appendMediaModeParam, normalizeMediaMode } from '$lib/media-mode';
import { withQuery } from '$lib/route-paths';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE,
	publicCollectionBiddingPath,
	publicCollectionTokensPath
} from '$lib/runtime/public-deployment';

export const load: PageLoad = async ({ fetch, url }) => {
	if (!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT || !PUBLIC_COLLECTION_SCOPE) {
		throw error(404, 'Not found');
	}

	const canonicalQuery = publicBidBookQuery(url.searchParams);
	if (canonicalQuery.toString() !== url.searchParams.toString()) {
		throw redirect(307, withQuery(publicCollectionBiddingPath(), canonicalQuery));
	}

	const preferredHref = resolvePreferredCollectionBiddingNavigationHref(url);
	if (preferredHref) {
		throw redirect(307, preferredHref);
	}

	const mediaMode = normalizeMediaMode(url.searchParams.get('media_mode'));

	try {
		// Load bid-book data and collection media without exposing bidding job management.
		const [bidBookResponse, collectionResponse] = await Promise.all([
			getCollectionBiddingBidBook(
				fetch,
				PUBLIC_COLLECTION_SCOPE.chainRef,
				PUBLIC_COLLECTION_SCOPE.collectionRef,
				url.searchParams
			),
			getCollectionDetail(
				fetch,
				PUBLIC_COLLECTION_SCOPE.chainRef,
				PUBLIC_COLLECTION_SCOPE.collectionRef,
				buildMediaModeQuery(mediaMode)
			)
		]);
		return {
			chain: bidBookResponse.chain,
			collection: bidBookResponse.collection,
			jobs: [],
			biddingSettings: defaultBiddingCollectionSettings(),
			priceTiers: [],
			bidBook: bidBookResponse.bidBook,
			tokenOfferCards: bidBookResponse.tokenOfferCards,
			facets: bidBookResponse.traits.facets,
			media: collectionResponse.media,
			included: {
				tokensById: {},
				hasTraitSummaryTemplate: false
			},
			basePath: publicCollectionTokensPath(),
			selectedTraits: bidBookResponse.traits.selected,
			selectedTraitRanges: bidBookResponse.traits.selectedRanges,
			bidScope: bidBookResponse.scopeFilter,
			traitJoinMode: parseCollectionBiddingTraitFilterJoinMode(url.searchParams),
			biddingView: 'bid_book' as const,
			showMuted: parseShowMutedBidBook(url.searchParams),
			makerFilter: parseBidBookMakerFilter(url.searchParams),
			mediaMode,
			requestCursor: url.searchParams.get('cursor')
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function publicBidBookQuery(searchParams: URLSearchParams): URLSearchParams {
	const query = new URLSearchParams(searchParams);
	if (parseCollectionBiddingView(query) === 'jobs') {
		query.delete(BIDDING_VIEW_QUERY_PARAM);
	}
	return query;
}

function buildMediaModeQuery(mediaMode: string | null): URLSearchParams {
	const query = new URLSearchParams();
	appendMediaModeParam(query, mediaMode);
	query.set('limit', String(DEFAULT_PAGE_LIMIT));
	return query;
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
