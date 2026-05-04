import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';
import {
	buildTokenBrowserQuery,
	COLLECTION_TOKEN_STATUS_FILTERS,
	TOKEN_STATUS_QUERY_PARAM
} from '$lib/token-browser-query';

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
