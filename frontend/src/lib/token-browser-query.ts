import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { TokenBrowserStatus } from '@artgod/shared/types/browse';
import type { ApiTokenAttribute } from '$lib/api-types';
import { appendMediaModeParam, normalizeMediaMode } from '$lib/media-mode';
import { appendNormalizedTraitParams, appendTraitParams } from '$lib/trait-filters';

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

	params.set('token_status', tokenStatus);
	appendMediaModeParam(params, normalizeMediaMode(raw.get('media_mode')));
	appendNormalizedTraitParams(params, raw);

	return params;
}

export function buildTokenBrowserHref(params: {
	basePath: string;
	limit: number;
	displayMode: 'grid' | 'table';
	tokenStatus: TokenBrowserStatus;
	selectedTraits: ApiTokenAttribute[];
	mediaMode?: string | null;
	cursor?: string | null;
}): string {
	const query = new URLSearchParams();
	query.set('limit', String(params.limit));
	query.set('mode', params.displayMode);
	query.set('token_status', params.tokenStatus);
	appendMediaModeParam(query, params.mediaMode ?? null);
	if (params.cursor?.trim()) {
		query.set('cursor', params.cursor.trim());
	}
	appendTraitParams(query, params.selectedTraits);
	return `${params.basePath}?${query.toString()}`;
}

export function buildOwnerTokensHref(params: {
	basePath: string;
	selectedTraits: ApiTokenAttribute[];
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
		mediaMode: params.mediaMode ?? null,
		cursor
	});
}

export function parseDisplayMode(raw: string | null): 'grid' | 'table' {
	if (raw?.trim().toLowerCase() === 'table') return 'table';
	return 'grid';
}

export function parseCollectionTokenStatus(raw: string | null): 'listed' | 'all' {
	if (raw?.trim().toLowerCase() === 'all') return 'all';
	return 'listed';
}
