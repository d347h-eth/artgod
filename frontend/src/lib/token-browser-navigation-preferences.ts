import { browser } from '$app/environment';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';
import {
	buildTokenBrowserQuery,
	COLLECTION_TOKEN_STATUS_FILTERS,
	TOKEN_STATUS_QUERY_PARAM,
	type CollectionTokenStatus
} from '$lib/token-browser-query';
import {
	applyQueryControlPreferenceToQuery,
	readScopedQueryControlPreference,
	writeScopedQueryControlPreference,
	type QueryControlPreferenceDefinitions
} from '$lib/query-control-preferences';
import { normalizeBasePath, withQuery } from '$lib/route-paths';

const STORAGE_KEY = 'artgod.collectionTokens.navigationPreferences.v1';

export type CollectionTokenNavigationPreference = {
	tokenStatus: CollectionTokenStatus;
};

const TOKEN_NAVIGATION_DEFINITIONS = {
	tokenStatus: {
		param: TOKEN_STATUS_QUERY_PARAM,
		values: COLLECTION_TOKEN_STATUS_FILTERS
	}
} satisfies QueryControlPreferenceDefinitions<CollectionTokenNavigationPreference>;

export function readCollectionTokenNavigationPreference(
	collectionPath: string
): Partial<CollectionTokenNavigationPreference> | null {
	return readScopedQueryControlPreference({
		storageKey: STORAGE_KEY,
		scopePath: collectionPath,
		definitions: TOKEN_NAVIGATION_DEFINITIONS
	});
}

export function writeCollectionTokenNavigationPreference(
	collectionPath: string,
	preference: CollectionTokenNavigationPreference
): void {
	writeScopedQueryControlPreference({
		storageKey: STORAGE_KEY,
		scopePath: collectionPath,
		definitions: TOKEN_NAVIGATION_DEFINITIONS,
		preference
	});
}

export function buildCollectionTokenNavigationQuery(params: {
	limit?: number;
	displayMode?: 'grid' | 'table';
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	mediaMode?: string | null;
}): URLSearchParams {
	const query = buildTokenBrowserQuery({
		limit: params.limit ?? DEFAULT_PAGE_LIMIT,
		displayMode: params.displayMode ?? 'grid',
		tokenStatus: COLLECTION_TOKEN_STATUS_FILTERS[0],
		selectedTraits: params.selectedTraits,
		selectedTraitRanges: params.selectedTraitRanges,
		mediaMode: params.mediaMode ?? null
	});
	query.delete(TOKEN_STATUS_QUERY_PARAM);
	return query;
}

export function preferredCollectionTokensHref(params: {
	basePath: string;
	query: URLSearchParams;
}): string {
	return withQuery(
		normalizeBasePath(params.basePath),
		applyCollectionTokenNavigationPreferenceToQuery(
			params.basePath,
			params.query,
			browser ? readCollectionTokenNavigationPreference(params.basePath) : null
		)
	);
}

export function applyCollectionTokenNavigationPreferenceToQuery(
	basePath: string,
	query: URLSearchParams,
	preference: Partial<CollectionTokenNavigationPreference> | null
): URLSearchParams {
	return applyQueryControlPreferenceToQuery({
		query,
		definitions: TOKEN_NAVIGATION_DEFINITIONS,
		preference: basePath.trim() ? preference : null
	});
}
