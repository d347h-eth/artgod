import { joinPath, normalizeBasePath, withQuery } from '../route-paths';
import { TRAIT_FILTER_QUERY_PARAMS } from '@artgod/shared/types';
import type { ApiTokenAttribute, ApiTraitRangeFilter } from '../api-types';
import { appendTraitParams, appendTraitRangeParams } from '../trait-filters';

export const COLLECTION_CHART_PATH = 'chart';
export const COLLECTION_CHART_TOKEN_QUERY = 'token_id';

/** Change traits without dropping chart range/bucket, token scope, or media preferences. */
export function buildCollectionChartFiltersHref(
	url: URL,
	traits: ApiTokenAttribute[],
	ranges: ApiTraitRangeFilter[]
): string {
	const query = new URLSearchParams(url.searchParams);
	for (const key of Object.values(TRAIT_FILTER_QUERY_PARAMS)) query.delete(key);
	appendTraitParams(query, traits);
	appendTraitRangeParams(query, ranges);
	return withQuery(url.pathname, query);
}

export function buildCollectionChartHref(
	basePath: string,
	tokenId?: string,
	params = new URLSearchParams()
): string {
	const query = new URLSearchParams(params);
	if (tokenId !== undefined) query.set(COLLECTION_CHART_TOKEN_QUERY, tokenId);
	return withQuery(joinPath(normalizeBasePath(basePath), COLLECTION_CHART_PATH), query);
}
