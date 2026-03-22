import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { TokenBrowserStatus } from '@artgod/shared/types/browse';
import type { ApiTokenAttribute } from '$lib/api-types';
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
	appendNormalizedTraitParams(params, raw);

	return params;
}

export function buildTokenBrowserHref(params: {
	basePath: string;
	limit: number;
	displayMode: 'grid' | 'table';
	tokenStatus: TokenBrowserStatus;
	selectedTraits: ApiTokenAttribute[];
	cursor?: string | null;
}): string {
	const query = new URLSearchParams();
	query.set('limit', String(params.limit));
	query.set('mode', params.displayMode);
	query.set('token_status', params.tokenStatus);
	if (params.cursor?.trim()) {
		query.set('cursor', params.cursor.trim());
	}
	appendTraitParams(query, params.selectedTraits);
	return `${params.basePath}?${query.toString()}`;
}

export function parseDisplayMode(raw: string | null): 'grid' | 'table' {
	if (raw?.trim().toLowerCase() === 'table') return 'table';
	return 'grid';
}

export function parseCollectionTokenStatus(raw: string | null): 'listed' | 'all' {
	if (raw?.trim().toLowerCase() === 'all') return 'all';
	return 'listed';
}
