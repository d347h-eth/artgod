import { error, redirect } from '@sveltejs/kit';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { getDefaultTransactionExplorerUrlTemplate } from '@artgod/shared/config/transaction-explorer';
import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import { BackendApiError, getCollectionActivities, getRuntimeConfig } from '$lib/backend-api';
import {
	ACTIVITY_CONTENT_HASH_QUERY_PARAM,
	ACTIVITY_EVENT_GROUP_QUERY_PARAM,
	ACTIVITY_EXTENSION_EVENT_QUERY_PARAM,
	ACTIVITY_KIND_QUERY_PARAM,
	ACTIVITY_MAKER_QUERY_PARAM,
	ACTIVITY_TOKEN_ID_QUERY_PARAM,
	normalizeCollectionActivityParams,
	parseCollectionActivityExtensionEvent,
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
				selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
				defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
				availableModes: [
					{ key: COLLECTION_MEDIA_MODES.Snapshot, label: COLLECTION_MEDIA_MODES.Snapshot }
				]
			},
			facets: [],
			selectedTraits: [],
			selectedTraitRanges: [],
			included: {
				tokensById: {},
				eventMediaByActivityId: {},
				hasTraitSummaryTemplate: false
			},
			basePath: '/',
			filterKind: 'sales' as const,
			extensionEvent: null,
			activityFilters: emptyActivityFilters(),
			transactionExplorerUrlTemplate: getDefaultTransactionExplorerUrlTemplate()
		};
	}

	const extensionEvent = parseCollectionActivityExtensionEvent(
		url.searchParams.get(ACTIVITY_EXTENSION_EVENT_QUERY_PARAM)
	);
	const parsedFilterKind = parseCollectionActivityKind(url.searchParams.get(ACTIVITY_KIND_QUERY_PARAM));
	const filterKind = extensionEvent ? null : parsedFilterKind;
	const query = normalizeCollectionActivityParams(
		url.searchParams,
		extensionEvent ? { extensionEvent } : { kind: parsedFilterKind }
	);

	try {
		const [response, runtimeConfigResponse] = await Promise.all([
			getCollectionActivities(fetch, params.chain_ref, params.collection_ref, query),
			getRuntimeConfig(fetch)
		]);
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
			filterKind,
			extensionEvent,
			activityFilters: readActivityFilters(url.searchParams),
			transactionExplorerUrlTemplate: runtimeConfigResponse.transactionExplorer.urlTemplate
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

function readActivityFilters(searchParams: URLSearchParams) {
	return {
		tokenId: nonEmpty(searchParams.get(ACTIVITY_TOKEN_ID_QUERY_PARAM)),
		maker: nonEmpty(searchParams.get(ACTIVITY_MAKER_QUERY_PARAM)),
		contentHash: nonEmpty(searchParams.get(ACTIVITY_CONTENT_HASH_QUERY_PARAM)),
		eventGroup: nonEmpty(searchParams.get(ACTIVITY_EVENT_GROUP_QUERY_PARAM))
	};
}

function emptyActivityFilters() {
	return {
		tokenId: null,
		maker: null,
		contentHash: null,
		eventGroup: null
	};
}

function nonEmpty(value: string | null): string | null {
	return value?.trim() || null;
}
