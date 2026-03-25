import { error } from '@sveltejs/kit';
import { normalizeAddressRef } from '@artgod/shared/utils/ref-resolver';
import type { PageLoad } from './$types';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { BackendApiError, getCollectionDetail } from '$lib/backend-api';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE
} from '$lib/runtime/public-deployment';
import { normalizeTokenBrowserParams, parseDisplayMode } from '$lib/token-browser-query';

export const load: PageLoad = async ({ fetch, params, url }) => {
	if (!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT || !PUBLIC_COLLECTION_SCOPE) {
		throw error(404, 'Not found');
	}

	const owner = normalizeAddressRef(params.owner_ref);
	const query = normalizeTokenBrowserParams(url.searchParams, 'listed_then_unlisted');
	query.set('owner', owner);
	const displayMode = parseDisplayMode(url.searchParams.get('mode'));

	try {
		const response = await getCollectionDetail(
			fetch,
			PUBLIC_COLLECTION_SCOPE.chainRef,
			PUBLIC_COLLECTION_SCOPE.collectionRef,
			query
		);
		const collectionBasePath = '/';
		const holdersBasePath = '/holders';
		const browserBasePath = `/holders/${encodeURIComponent(owner)}`;
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
