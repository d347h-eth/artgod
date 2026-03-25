import { error, redirect } from '@sveltejs/kit';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { BackendApiError, getCollectionActivities } from '$lib/backend-api';
import {
	normalizeCollectionActivityParams,
	parseCollectionActivityKind
} from '$lib/activity-query';
import { withQuery } from '$lib/route-paths';
import {
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT,
	PUBLIC_COLLECTION_SCOPE,
	matchesPublicCollectionRoute,
	publicCollectionActivityPath
} from '$lib/runtime/public-deployment';
import { IS_ADMIN_FRONTEND_TARGET } from '$lib/runtime/frontend-target';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, url }) => {
	if (IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT) {
		if (!PUBLIC_COLLECTION_SCOPE) {
			throw error(500, 'Public collection scope is not configured');
		}
		if (!matchesPublicCollectionRoute(params.chain_ref, params.collection_ref)) {
			throw error(404, 'Not found');
		}
		throw redirect(307, withQuery(publicCollectionActivityPath(), url.searchParams));
	}

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
			media: {
				selectedMode: 'snapshot',
				defaultMode: 'snapshot',
				availableModes: [{ key: 'snapshot', label: 'snapshot' }]
			},
			facets: [],
			selectedTraits: [],
			selectedTraitRanges: [],
			included: {
				tokensById: {},
				hasTraitSummaryTemplate: false
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
			media: response.media,
			activities: response.activities,
			facets: response.traits.facets,
			selectedTraits: response.traits.selected,
			selectedTraitRanges: response.traits.selectedRanges,
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
