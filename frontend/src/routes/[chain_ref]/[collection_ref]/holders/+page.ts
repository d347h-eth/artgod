import { error, redirect } from '@sveltejs/kit';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import { BackendApiError, getCollectionHolders, getRuntimeConfig } from '$lib/backend-api';
import {
	MEDIA_MODE_QUERY_PARAM,
	MEDIA_PREFERENCE_QUERY_PARAM,
	appendMediaModeParam,
	appendNormalizedMediaPreferenceParam,
	normalizeMediaMode,
	normalizeMediaPreferenceValue
} from '$lib/media-mode';
import { withQuery } from '$lib/route-paths';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE,
	matchesPublicCollectionRoute,
	publicCollectionHoldersPath
} from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, url }) => {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		if (!PUBLIC_COLLECTION_SCOPE) {
			throw error(500, 'Public collection scope is not configured');
		}
		if (!matchesPublicCollectionRoute(params.chain_ref, params.collection_ref)) {
			throw error(404, 'Not found');
		}
		throw redirect(307, withQuery(publicCollectionHoldersPath(), url.searchParams));
	}

	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			chain: null,
			collection: null,
			holders: {
				items: [],
				nextCursor: null,
				limit: DEFAULT_PAGE_LIMIT,
				totalItems: 0,
				rangeStart: 0,
				rangeEnd: 0,
				currentPage: 0,
				totalPages: 0
			},
			basePath: '/',
			selectedMediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			selectedMediaPreference: null,
			requestCursor: null
		};
	}

	const query = normalizeCollectionHoldersParams(url.searchParams);

	try {
		const [response, runtimeConfigResponse] = await Promise.all([
			getCollectionHolders(fetch, params.chain_ref, params.collection_ref, query),
			getRuntimeConfig(fetch)
		]);
		return {
			chain: response.chain,
			collection: response.collection,
			holders: response.holders,
			basePath: `/${response.chain.slug}/${response.collection.slug}`,
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
