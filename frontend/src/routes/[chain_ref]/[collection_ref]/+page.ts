import { error, redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import {
	BackendApiError,
	getCollectionBiddingPriceTiers,
	getCollectionDetail
} from '$lib/backend-api';
import { withQuery } from '$lib/route-paths';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
		PUBLIC_COLLECTION_SCOPE,
		matchesPublicCollectionRoute,
		publicCollectionTokensPath
} from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import {
	normalizeTokenBrowserParams,
	parseCollectionTokenStatus,
	parseDisplayMode
} from '$lib/token-browser-query';

export const load: PageLoad = async ({ fetch, params, url }) => {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		if (!PUBLIC_COLLECTION_SCOPE) {
			throw error(500, 'Public collection scope is not configured');
		}
		if (!matchesPublicCollectionRoute(params.chain_ref, params.collection_ref)) {
			throw error(404, 'Not found');
		}
		throw redirect(307, withQuery(publicCollectionTokensPath(), url.searchParams));
	}

	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			chain: null,
			collection: null,
			tokens: {
				items: [],
				prevCursor: null,
				nextCursor: null,
				limit: DEFAULT_PAGE_LIMIT,
				totalItems: 0,
				rangeStart: 0,
				rangeEnd: 0,
				currentPage: 0,
				totalPages: 0
			},
			media: {
				selectedMode: 'snapshot',
				defaultMode: 'snapshot',
				availableModes: [{ key: 'snapshot', label: 'snapshot' }]
			},
			facets: [],
			selectedTraits: [],
			selectedTraitRanges: [],
			basePath: '/',
			requestCursor: null,
			tokenStatus: 'listed' as const,
			displayMode: 'grid' as const,
			priceTiers: []
		};
	}
	const tokenStatus = parseCollectionTokenStatus(url.searchParams.get('token_status'));
	const query = normalizeTokenBrowserParams(url.searchParams, tokenStatus);
	const displayMode = parseDisplayMode(url.searchParams.get('mode'));

	try {
		const [response, priceTiersResponse] = await Promise.all([
			getCollectionDetail(fetch, params.chain_ref, params.collection_ref, query),
			getCollectionBiddingPriceTiers(fetch, params.chain_ref, params.collection_ref)
		]);
		return {
			chain: response.chain,
			collection: response.collection,
			media: response.media,
			tokens: response.tokens,
			facets: response.traits.facets,
			selectedTraits: response.traits.selected,
			selectedTraitRanges: response.traits.selectedRanges,
			basePath: `/${response.chain.slug}/${response.collection.slug}`,
			requestCursor: query.get('cursor') ?? null,
			tokenStatus,
			displayMode,
			priceTiers: priceTiersResponse.tiers
		};
	} catch (cause) {
		toKitError(cause);
	}
};

function toKitError(cause: unknown): never {
	if (cause instanceof BackendApiError) {
		throw error(cause.status, cause.message);
	}
	throw error(500, 'Backend request failed');
}
