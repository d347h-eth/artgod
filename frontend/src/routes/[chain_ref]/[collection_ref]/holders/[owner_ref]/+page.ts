import { error } from '@sveltejs/kit';
import { normalizeAddressRef } from '@artgod/shared/utils/ref-resolver';
import type { PageLoad } from './$types';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { BackendApiError, getCollectionDetail } from '$lib/backend-api';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import { normalizeTokenBrowserParams, parseDisplayMode } from '$lib/token-browser-query';

export const load: PageLoad = async ({ fetch, params, url }) => {
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
				selectedMode: 'truth',
				defaultMode: 'truth',
				availableModes: [{ key: 'truth', label: 'truth' }]
			},
			facets: [],
			selectedTraits: [],
			collectionBasePath: '/',
			holdersBasePath: '/',
			browserBasePath: '/',
			owner,
			requestCursor: null,
			displayMode
		};
	}

	try {
		const response = await getCollectionDetail(fetch, params.chain_ref, params.collection_ref, query);
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
