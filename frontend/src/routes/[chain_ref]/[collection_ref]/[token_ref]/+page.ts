import { error, redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { COLLECTION_MEDIA_MODE_OPTIONS, COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import {
	BackendApiError,
	getCollectionBiddingPriceTiers,
	getRuntimeConfig,
	getTokenBiddingBidBook,
	getTokenBiddingJob,
	getTokenDetail
} from '$lib/backend-api';
import { defaultBiddingCollectionSettings } from '$lib/bidding-collection-settings';
import { emptyBiddingBidBook } from '$lib/bidding-empty-state';
import { parseShowMutedBidBook } from '$lib/bidding-query';
import {
	MEDIA_MODE_QUERY_PARAM,
	MEDIA_PREFERENCE_QUERY_PARAM,
	MEDIA_VARIANT_QUERY_PARAM,
	buildTokenMediaQuery,
	normalizeMediaMode,
	normalizeMediaPreferenceValue
} from '$lib/media-mode';
import { withQuery } from '$lib/route-paths';
import { defaultTraitFilterPresentationState } from '$lib/trait-filter-presentation';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE,
	matchesPublicCollectionRoute,
	publicCollectionTokenDetailPath
} from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';

export const load: PageLoad = async ({ fetch, params, url }) => {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		if (!PUBLIC_COLLECTION_SCOPE) {
			throw error(500, 'Public collection scope is not configured');
		}
		if (!matchesPublicCollectionRoute(params.chain_ref, params.collection_ref)) {
			throw error(404, 'Not found');
		}
		throw redirect(
			307,
			withQuery(publicCollectionTokenDetailPath(params.token_ref), url.searchParams)
		);
	}

	const { backPath, backQuery } = normalizeReturnState(url.searchParams);
	const mediaMode = normalizeMediaMode(url.searchParams.get(MEDIA_MODE_QUERY_PARAM));
	const mediaPreference = normalizeMediaPreferenceValue(
		url.searchParams.get(MEDIA_PREFERENCE_QUERY_PARAM)
	);
	const mediaVariant = normalizeMediaMode(url.searchParams.get(MEDIA_VARIANT_QUERY_PARAM));

	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			chain: null,
			collection: null,
			media: {
				selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
				defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
				availableModes: [COLLECTION_MEDIA_MODE_OPTIONS.Snapshot],
				preference: null,
				selectedVariant: null,
				defaultVariant: null,
				availableVariants: []
			},
			token: null,
			biddingSettings: defaultBiddingCollectionSettings(),
			priceTiers: [],
			traitFilterPresentation: defaultTraitFilterPresentationState(),
			tokenBiddingBidBook: emptyBiddingBidBook(),
			showMuted: parseShowMutedBidBook(url.searchParams),
			backPath,
			backQuery
		};
	}

	try {
		// Load the token detail and its token-scoped bidding job together for the page shell.
		const [
			response,
			biddingJobResponse,
			biddingBidBookResponse,
			priceTiersResponse,
			runtimeConfigResponse
		] = await Promise.all([
			getTokenDetail(
				fetch,
				params.chain_ref,
				params.collection_ref,
				params.token_ref,
				buildTokenMediaQuery({ mediaMode, mediaPreference, mediaVariant })
			),
			getTokenBiddingJob(fetch, params.chain_ref, params.collection_ref, params.token_ref),
			getTokenBiddingBidBook(fetch, params.chain_ref, params.collection_ref, params.token_ref),
			getCollectionBiddingPriceTiers(fetch, params.chain_ref, params.collection_ref),
			getRuntimeConfig(fetch)
		]);
		return {
			chain: response.chain,
			collection: response.collection,
			media: response.media,
			token: response.token,
			biddingSettings: priceTiersResponse.settings,
			priceTiers: priceTiersResponse.tiers,
			trustOpenSeaSignedZoneTraitOffers:
				runtimeConfigResponse.bidding.trustOpenSeaSignedZoneTraitOffers,
			traitFilterPresentation: response.traitFilterPresentation,
			tokenBiddingJob: biddingJobResponse.job,
			tokenBiddingBidBook: biddingBidBookResponse.bidBook,
			bidBookLiveRefreshConfig: runtimeConfigResponse.bidding.bidBookLiveRefresh,
			showMuted: parseShowMutedBidBook(url.searchParams),
			backPath,
			backQuery
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function normalizeReturnState(searchParams: URLSearchParams): {
	backPath: string | null;
	backQuery: string | null;
} {
	const rawPath = searchParams.get('returnPath');
	const backPath = rawPath && rawPath.startsWith('/') ? rawPath : null;

	const rawQuery = searchParams.get('returnQuery');
	if (rawQuery && rawQuery.trim()) {
		return {
			backPath,
			backQuery: rawQuery.trim()
		};
	}

	const rawCursor = searchParams.get('returnCursor');
	if (!rawCursor || !rawCursor.trim()) {
		return {
			backPath,
			backQuery: null
		};
	}

	const query = new URLSearchParams();
	query.set('cursor', rawCursor.trim());
	return {
		backPath,
		backQuery: query.toString()
	};
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
