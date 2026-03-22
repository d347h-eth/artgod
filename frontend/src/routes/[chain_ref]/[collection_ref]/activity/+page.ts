import { error } from '@sveltejs/kit';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { BackendApiError, getCollectionActivities } from '$lib/backend-api';
import {
	normalizeCollectionActivityParams,
	parseCollectionActivityKind
} from '$lib/activity-query';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, url }) => {
	if (IS_ADMIN_FRONTEND_TARGET) {
		return {
			chain: null,
			collection: null,
			activities: {
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
			facets: [],
			selectedTraits: [],
			included: {
				tokensById: {}
			},
			basePath: '/',
			filterKind: 'sales' as const
		};
	}

	const filterKind = parseCollectionActivityKind(url.searchParams.get('kind'));
	const query = normalizeCollectionActivityParams(url.searchParams, filterKind);

	try {
		const response = await getCollectionActivities(
			fetch,
			params.chain_ref,
			params.collection_ref,
			query
		);
		return {
			chain: response.chain,
			collection: response.collection,
			activities: response.activities,
			facets: response.traits.facets,
			selectedTraits: response.traits.selected,
			included: response.included,
			basePath: `/${response.chain.slug}/${response.collection.slug}`,
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
