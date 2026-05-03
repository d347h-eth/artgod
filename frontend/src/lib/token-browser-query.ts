import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { TokenBrowserStatus } from '@artgod/shared/types/browse';
import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';
import { appendMediaModeParam, normalizeMediaMode } from '$lib/media-mode';
import { normalizeBasePath, withQuery } from '$lib/route-paths';
import {
	appendNormalizedTraitParams,
	appendNormalizedTraitRangeParams,
	appendTraitParams,
	appendTraitRangeParams
} from '$lib/trait-filters';

export const TOKEN_STATUS_QUERY_PARAM = 'token_status';
export const COLLECTION_TOKEN_STATUS_FILTERS = ['listed', 'all'] as const;
export type CollectionTokenStatus = (typeof COLLECTION_TOKEN_STATUS_FILTERS)[number];

export function normalizeTokenBrowserParams(
	raw: URLSearchParams,
	tokenStatus: TokenBrowserStatus
): URLSearchParams {
	const params = new URLSearchParams();

	const limit = raw.get('limit');
	params.set('limit', limit && /^\d+$/.test(limit) ? limit : String(DEFAULT_PAGE_LIMIT));

	const cursor = raw.get('cursor');
	if (cursor && cursor.trim()) {
		params.set('cursor', cursor.trim());
	}

	params.set(TOKEN_STATUS_QUERY_PARAM, tokenStatus);
	appendMediaModeParam(params, normalizeMediaMode(raw.get('media_mode')));
	appendNormalizedTraitParams(params, raw);
	appendNormalizedTraitRangeParams(params, raw);

	return params;
}

export function buildTokenBrowserQuery(params: {
	limit: number;
	displayMode: 'grid' | 'table';
	tokenStatus: TokenBrowserStatus;
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	mediaMode?: string | null;
	cursor?: string | null;
}): URLSearchParams {
	const query = new URLSearchParams();
	query.set('limit', String(params.limit));
	query.set('mode', params.displayMode);
	query.set(TOKEN_STATUS_QUERY_PARAM, params.tokenStatus);
	appendMediaModeParam(query, params.mediaMode ?? null);
	if (params.cursor?.trim()) {
		query.set('cursor', params.cursor.trim());
	}
	appendTraitParams(query, params.selectedTraits);
	appendTraitRangeParams(query, params.selectedTraitRanges);
	return query;
}

export function buildTokenBrowserHref(params: {
	basePath: string;
	limit: number;
	displayMode: 'grid' | 'table';
	tokenStatus: TokenBrowserStatus;
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	mediaMode?: string | null;
	cursor?: string | null;
}): string {
	return withQuery(normalizeBasePath(params.basePath), buildTokenBrowserQuery(params));
}

export function buildOwnerTokensHref(params: {
	basePath: string;
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	mediaMode?: string | null;
	limit?: number;
	displayMode?: 'grid' | 'table';
	cursor?: string | null;
}): string {
	const limit = params.limit ?? DEFAULT_PAGE_LIMIT;
	const displayMode = params.displayMode ?? 'grid';
	const cursor = params.cursor ?? null;

	if (
		limit === DEFAULT_PAGE_LIMIT &&
		displayMode === 'grid' &&
		!cursor?.trim() &&
		params.selectedTraits.length === 0 &&
		params.selectedTraitRanges.length === 0 &&
		!(params.mediaMode ?? '').trim()
	) {
		return params.basePath;
	}

	return buildTokenBrowserHref({
		basePath: params.basePath,
		limit,
		displayMode,
		tokenStatus: 'listed_then_unlisted',
		selectedTraits: params.selectedTraits,
		selectedTraitRanges: params.selectedTraitRanges,
		mediaMode: params.mediaMode ?? null,
		cursor
	});
}

export function buildTokenDetailHref(params: {
	basePath: string;
	tokenId: string;
	mediaMode?: string | null;
	returnPath?: string | null;
	returnQuery?: string | null;
}): string {
	const query = new URLSearchParams();
	appendMediaModeParam(query, params.mediaMode ?? null);
	if (params.returnPath?.trim()) {
		query.set('returnPath', params.returnPath.trim());
	}
	if (params.returnQuery?.trim()) {
		query.set('returnQuery', params.returnQuery.trim());
	}
	const suffix = query.toString();
	return withQuery(
		normalizeBasePath(params.basePath) === '/'
			? `/${encodeURIComponent(params.tokenId)}`
			: `${normalizeBasePath(params.basePath)}/${encodeURIComponent(params.tokenId)}`,
		suffix
	);
}

export function parseDisplayMode(raw: string | null): 'grid' | 'table' {
	if (raw?.trim().toLowerCase() === 'table') return 'table';
	return 'grid';
}

export function parseCollectionTokenStatus(raw: string | null): 'listed' | 'all' {
	if (raw?.trim().toLowerCase() === 'all') return 'all';
	return 'listed';
}
