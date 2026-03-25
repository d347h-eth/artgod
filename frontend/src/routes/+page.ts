import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { BackendApiError, getCollectionDetail, getCollectionsPage, getDefaultChain } from '$lib/backend-api';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE
} from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import { shouldDeferInitialBackendLoad } from '$lib/runtime/initial-load';
import {
	normalizeTokenBrowserParams,
	parseCollectionTokenStatus,
	parseDisplayMode
} from '$lib/token-browser-query';

export const load: PageLoad = async ({ fetch, url }) => {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		if (!PUBLIC_COLLECTION_SCOPE) {
			throw error(500, 'Public collection scope is not configured');
		}

		const tokenStatus = parseCollectionTokenStatus(url.searchParams.get('token_status'));
		const query = normalizeTokenBrowserParams(url.searchParams, tokenStatus);
		const displayMode = parseDisplayMode(url.searchParams.get('mode'));

		try {
			const response = await getCollectionDetail(
				fetch,
				PUBLIC_COLLECTION_SCOPE.chainRef,
				PUBLIC_COLLECTION_SCOPE.collectionRef,
				query
			);
			return {
				mode: 'public_collection' as const,
				chain: response.chain,
				collection: response.collection,
				media: response.media,
				tokens: response.tokens,
				facets: response.traits.facets,
				selectedTraits: response.traits.selected,
				selectedTraitRanges: response.traits.selectedRanges,
				basePath: '/',
				requestCursor: query.get('cursor') ?? null,
				tokenStatus,
				displayMode
			};
		} catch (cause) {
			toKitError(cause);
		}
	}

	const params = normalizeCollectionsParams(url.searchParams);
	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			mode: 'collections' as const,
			chain: null,
			page: {
				items: [],
				nextCursor: null,
				limit: DEFAULT_PAGE_LIMIT
			},
			status: '',
			basePath: '/',
			deferred: false
		};
	}
	if (await shouldDeferInitialBackendLoad()) {
		return {
			mode: 'collections' as const,
			chain: null,
			page: {
				items: [],
				nextCursor: null,
				limit: DEFAULT_PAGE_LIMIT
			},
			status: params.get('status') ?? '',
			basePath: '/',
			deferred: true
		};
	}

	try {
		const defaultChain = await getDefaultChain(fetch);
		const response = await getCollectionsPage(fetch, defaultChain.chain.slug, params);
		return {
			mode: 'collections' as const,
			chain: response.chain,
			page: response.page,
			status: response.filters.status ?? '',
			basePath: '/',
			deferred: false
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
