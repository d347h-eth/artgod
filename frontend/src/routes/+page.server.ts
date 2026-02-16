import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import {
	BackendApiError,
	getCollectionsPage,
	getDefaultChain
} from '$lib/server/backend-api';

export const load: PageServerLoad = async ({ fetch, url }) => {
	const params = normalizeCollectionsParams(url.searchParams);

	try {
		const defaultChain = await getDefaultChain(fetch);
		const response = await getCollectionsPage(fetch, defaultChain.chain.slug, params);
		return {
			chain: response.chain,
			page: response.page,
			status: response.filters.status ?? '',
			basePath: '/'
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function normalizeCollectionsParams(raw: URLSearchParams): URLSearchParams {
	const params = new URLSearchParams();

	const status = raw.get('status');
	if (status && status.trim()) {
		params.set('status', status.trim());
	}

	const limit = raw.get('limit');
	params.set('limit', limit && /^\d+$/.test(limit) ? limit : String(DEFAULT_PAGE_LIMIT));

	const cursor = raw.get('cursor');
	if (cursor && cursor.trim()) {
		params.set('cursor', cursor.trim());
	}

	return params;
}

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
