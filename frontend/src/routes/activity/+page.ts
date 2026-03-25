import { error } from '@sveltejs/kit';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { BackendApiError, getCollectionActivities } from '$lib/backend-api';
import {
	normalizeCollectionActivityParams,
	parseCollectionActivityKind
} from '$lib/activity-query';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE
} from '$lib/runtime/public-deployment';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	if (!IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT || !PUBLIC_COLLECTION_SCOPE) {
		throw error(404, 'Not found');
	}

	const filterKind = parseCollectionActivityKind(url.searchParams.get('kind'));
	const query = normalizeCollectionActivityParams(url.searchParams, filterKind);

	try {
		const response = await getCollectionActivities(
			fetch,
			PUBLIC_COLLECTION_SCOPE.chainRef,
			PUBLIC_COLLECTION_SCOPE.collectionRef,
			query
		);
		return {
			chain: response.chain,
			collection: response.collection,
			media: response.media,
			activities: response.activities,
			facets: response.traits.facets,
			selectedTraits: response.traits.selected,
			selectedTraitRanges: response.traits.selectedRanges,
			included: response.included,
			basePath: '/',
			filterKind
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
