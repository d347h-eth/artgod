import { error, redirect } from '@sveltejs/kit';
import { normalizeAddressRef } from '@artgod/shared/utils/ref-resolver';
import type { PageLoad } from './$types';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { BackendApiError, getCollectionDetailWithHeaders } from '$lib/backend-api';
import { forwardQueryCacheResponseHeaders } from '$lib/query-cache-response-headers';
import { withQuery } from '$lib/route-paths';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE,
	matchesPublicCollectionRoute,
	publicCollectionOwnerTokensPath
} from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import { normalizeTokenBrowserParams, parseDisplayMode } from '$lib/token-browser-query';

export const load: PageLoad = async ({ fetch, params, setHeaders, url }) => {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		if (!PUBLIC_COLLECTION_SCOPE) {
			throw error(500, 'Public collection scope is not configured');
		}
		if (!matchesPublicCollectionRoute(params.chain_ref, params.collection_ref)) {
			throw error(404, 'Not found');
		}
		throw redirect(307, withQuery(publicCollectionOwnerTokensPath(params.owner_ref), url.searchParams));
	}

	const owner = normalizeAddressRef(params.owner_ref);
	const query = normalizeTokenBrowserParams(url.searchParams, 'listed_then_unlisted');
	query.set('owner', owner);
	const displayMode = parseDisplayMode(url.searchParams.get('mode'));

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
			collectionBasePath: '/',
			holdersBasePath: '/',
			browserBasePath: '/',
			owner,
			requestCursor: null,
			displayMode
		};
	}

	try {
		const responseWithHeaders = await getCollectionDetailWithHeaders(
			fetch,
			params.chain_ref,
			params.collection_ref,
			query
		);
		forwardQueryCacheResponseHeaders(setHeaders, responseWithHeaders.headers);
		const response = responseWithHeaders.payload;
		const collectionBasePath = `/${response.chain.slug}/${response.collection.slug}`;
		const holdersBasePath = `${collectionBasePath}/holders`;
		const browserBasePath = `${holdersBasePath}/${encodeURIComponent(owner)}`;
		return {
			chain: response.chain,
			collection: response.collection,
			media: response.media,
			tokens: response.tokens,
			facets: response.traits.facets,
			selectedTraits: response.traits.selected,
			selectedTraitRanges: response.traits.selectedRanges,
			collectionBasePath,
			holdersBasePath,
			browserBasePath,
			owner,
			requestCursor: query.get('cursor') ?? null,
			displayMode
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
