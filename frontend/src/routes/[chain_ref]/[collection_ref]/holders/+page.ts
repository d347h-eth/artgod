import { error, redirect } from '@sveltejs/kit';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import { BackendApiError, getCollectionHolders } from '$lib/backend-api';
import { appendMediaModeParam, normalizeMediaMode } from '$lib/media-mode';
import {
	collectionMediaModePreferenceScope,
	resolvePreferredCollectionMediaModeHref
} from '$lib/media-mode-navigation-preferences';
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
			requestCursor: null
		};
	}

	const preferredMediaHref = resolvePreferredCollectionMediaModeHref({
		url,
		scopePath: collectionMediaModePreferenceScope({
			chainRef: params.chain_ref,
			collectionRef: params.collection_ref
		})
	});
	if (preferredMediaHref) {
		throw redirect(307, preferredMediaHref);
	}

	const query = normalizeCollectionHoldersParams(url.searchParams);

	try {
		const response = await getCollectionHolders(
			fetch,
			params.chain_ref,
			params.collection_ref,
			query
		);
		return {
			chain: response.chain,
			collection: response.collection,
			holders: response.holders,
			basePath: `/${response.chain.slug}/${response.collection.slug}`,
			selectedMediaMode: normalizeMediaMode(url.searchParams.get('media_mode')),
			requestCursor: query.get('cursor') ?? null
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

	appendMediaModeParam(params, normalizeMediaMode(raw.get('media_mode')));

	return params;
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
