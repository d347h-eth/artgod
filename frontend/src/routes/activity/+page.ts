import { error } from '@sveltejs/kit';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { BackendApiError, getCollectionActivities } from '$lib/backend-api';
import {
	ACTIVITY_EXTENSION_EVENT_QUERY_PARAM,
	ACTIVITY_CONTENT_HASH_QUERY_PARAM,
	ACTIVITY_MAKER_QUERY_PARAM,
	ACTIVITY_KIND_QUERY_PARAM,
	ACTIVITY_TOKEN_ID_QUERY_PARAM,
	normalizeCollectionActivityParams,
	parseCollectionActivityExtensionEvent,
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
			filterKind,
			extensionEvent,
			activityFilters: readActivityFilters(url.searchParams)
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
		contentHash: nonEmpty(searchParams.get(ACTIVITY_CONTENT_HASH_QUERY_PARAM))
	};
}

function nonEmpty(value: string | null): string | null {
	return value?.trim() || null;
}
