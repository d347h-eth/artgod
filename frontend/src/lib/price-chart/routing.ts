import { joinPath, normalizeBasePath, withQuery } from '../route-paths';

export const COLLECTION_CHART_PATH = 'chart';
export const COLLECTION_CHART_TOKEN_QUERY = 'token_id';

export function buildCollectionChartHref(
	basePath: string,
	tokenId?: string,
	params = new URLSearchParams()
): string {
	const query = new URLSearchParams(params);
	if (tokenId !== undefined) query.set(COLLECTION_CHART_TOKEN_QUERY, tokenId);
	return withQuery(joinPath(normalizeBasePath(basePath), COLLECTION_CHART_PATH), query);
}
