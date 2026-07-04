import { error, redirect } from '@sveltejs/kit';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { BackendApiError, getCollectionHolders } from '$lib/backend-api';
import { appendMediaModeParam, normalizeMediaMode } from '$lib/media-mode';
import { resolvePreferredCollectionMediaModeHref } from '$lib/media-mode-navigation-preferences';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE,
	publicCollectionTokensPath
} from '$lib/runtime/public-deployment';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	if (!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT || !PUBLIC_COLLECTION_SCOPE) {
		throw error(404, 'Not found');
	}

	const preferredMediaHref = resolvePreferredCollectionMediaModeHref({
		url,
		scopePath: publicCollectionTokensPath()
	});
	if (preferredMediaHref) {
		throw redirect(307, preferredMediaHref);
	}

	const query = normalizeCollectionHoldersParams(url.searchParams);

	try {
		const response = await getCollectionHolders(
			fetch,
			PUBLIC_COLLECTION_SCOPE.chainRef,
			PUBLIC_COLLECTION_SCOPE.collectionRef,
			query
		);
		return {
			chain: response.chain,
			collection: response.collection,
			holders: response.holders,
			basePath: '/',
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
