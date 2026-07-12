import { error } from '@sveltejs/kit';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { BackendApiError, getCollectionHolders, getRuntimeConfig } from '$lib/backend-api';
import {
	MEDIA_MODE_QUERY_PARAM,
	MEDIA_PREFERENCE_QUERY_PARAM,
	appendMediaModeParam,
	appendNormalizedMediaPreferenceParam,
	normalizeMediaMode,
	normalizeMediaPreferenceValue
} from '$lib/media-mode';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE
} from '$lib/runtime/public-deployment';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	if (!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT || !PUBLIC_COLLECTION_SCOPE) {
		throw error(404, 'Not found');
	}

	const query = normalizeCollectionHoldersParams(url.searchParams);

	try {
		const [response, runtimeConfigResponse] = await Promise.all([
			getCollectionHolders(
				fetch,
				PUBLIC_COLLECTION_SCOPE.chainRef,
				PUBLIC_COLLECTION_SCOPE.collectionRef,
				query
			),
			getRuntimeConfig(fetch)
		]);
		return {
			chain: response.chain,
			collection: response.collection,
			holders: response.holders,
			basePath: '/',
			selectedMediaMode: normalizeMediaMode(url.searchParams.get(MEDIA_MODE_QUERY_PARAM)),
			selectedMediaPreference: normalizeMediaPreferenceValue(
				url.searchParams.get(MEDIA_PREFERENCE_QUERY_PARAM)
			),
			requestCursor: query.get('cursor') ?? null,
			blockExplorer: runtimeConfigResponse.blockExplorer
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function normalizeCollectionHoldersParams(raw: URLSearchParams): URLSearchParams {
	const params = new URLSearchParams();

	const limit = raw.get('limit');
	params.set('limit', limit && /^\d+$/.test(limit) ? limit : String(DEFAULT_PAGE_LIMIT));

	const cursor = raw.get('cursor');
	if (cursor && cursor.trim()) {
		params.set('cursor', cursor.trim());
	}

	appendMediaModeParam(params, normalizeMediaMode(raw.get(MEDIA_MODE_QUERY_PARAM)));
	appendNormalizedMediaPreferenceParam(params, raw.get(MEDIA_PREFERENCE_QUERY_PARAM));

	return params;
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
