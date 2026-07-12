import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { BackendApiError, getTokenBiddingBidBook, getTokenDetail } from '$lib/backend-api';
import { parseShowMutedBidBook } from '$lib/bidding-query';
import {
	MEDIA_MODE_QUERY_PARAM,
	MEDIA_PREFERENCE_QUERY_PARAM,
	MEDIA_VARIANT_QUERY_PARAM,
	buildTokenMediaQuery,
	normalizeMediaMode,
	normalizeMediaPreferenceValue
} from '$lib/media-mode';
import { defaultTraitFilterPresentationState } from '$lib/trait-filter-presentation';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE
} from '$lib/runtime/public-deployment';

export const load: PageLoad = async ({ fetch, params, url }) => {
	if (!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT || !PUBLIC_COLLECTION_SCOPE) {
		throw error(404, 'Not found');
	}

	const { backPath, backQuery } = normalizeReturnState(url.searchParams);
	const mediaMode = normalizeMediaMode(url.searchParams.get(MEDIA_MODE_QUERY_PARAM));
	const mediaPreference = normalizeMediaPreferenceValue(
		url.searchParams.get(MEDIA_PREFERENCE_QUERY_PARAM)
	);
	const mediaVariant = normalizeMediaMode(url.searchParams.get(MEDIA_VARIANT_QUERY_PARAM));

	try {
		// Load token media/details and read-only bid book without exposing bidding job controls.
		const [response, biddingBidBookResponse] = await Promise.all([
			getTokenDetail(
				fetch,
				PUBLIC_COLLECTION_SCOPE.chainRef,
				PUBLIC_COLLECTION_SCOPE.collectionRef,
				params.token_ref,
				buildTokenMediaQuery({ mediaMode, mediaPreference, mediaVariant })
			),
			getTokenBiddingBidBook(
				fetch,
				PUBLIC_COLLECTION_SCOPE.chainRef,
				PUBLIC_COLLECTION_SCOPE.collectionRef,
				params.token_ref
			)
		]);
		return {
			chain: response.chain,
			collection: response.collection,
			media: response.media,
			token: response.token,
			traitFilterPresentation:
				response.traitFilterPresentation ?? defaultTraitFilterPresentationState(),
			tokenBiddingBidBook: biddingBidBookResponse.bidBook,
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
