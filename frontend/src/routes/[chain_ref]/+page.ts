import { error, redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { BackendApiError, getCollectionsPage } from '$lib/backend-api';
import { withQuery } from '$lib/route-paths';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE,
	publicCollectionTokensPath
} from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';

export const load: PageLoad = async ({ fetch, params, url }) => {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		if (!PUBLIC_COLLECTION_SCOPE) {
			throw error(500, 'Public collection scope is not configured');
		}
		if (params.chain_ref !== PUBLIC_COLLECTION_SCOPE.chainRef) {
			throw error(404, 'Not found');
		}
		throw redirect(307, withQuery(publicCollectionTokensPath(), url.searchParams));
	}

	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			chain: null,
			page: {
				items: [],
				nextCursor: null,
				limit: DEFAULT_PAGE_LIMIT
			},
			status: '',
			basePath: '/'
		};
	}
	const query = normalizeCollectionsParams(url.searchParams);

	try {
		const response = await getCollectionsPage(fetch, params.chain_ref, query);
		return {
			chain: response.chain,
			page: response.page,
			status: response.filters.status ?? '',
			basePath: `/${response.chain.slug}`
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
