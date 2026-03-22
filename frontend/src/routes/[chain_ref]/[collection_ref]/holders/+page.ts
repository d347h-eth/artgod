import { error } from '@sveltejs/kit';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { BackendApiError, getCollectionHolders } from '$lib/backend-api';
import { appendMediaModeParam, normalizeMediaMode } from '$lib/media-mode';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, url }) => {
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
			selectedMediaMode: 'truth',
			requestCursor: null
		};
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
			selectedMediaMode: normalizeMediaMode(url.searchParams.get('media_mode')) ?? 'truth',
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
