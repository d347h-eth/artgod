import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { TokenBrowserStatus } from '@artgod/shared/types/browse';
import type { ApiTokenAttribute } from '$lib/api-types';

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

	const traitValues = [...raw.getAll('traits'), ...raw.getAll('trait')];
	appendTokenBrowserTraitParams(params, traitValues);

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
	appendTokenBrowserTraitParams(
		query,
		params.selectedTraits.map((trait) => `${trait.key}:${trait.value}`)
	);
	return `${params.basePath}?${query.toString()}`;
}

function appendTokenBrowserTraitParams(
	params: URLSearchParams,
	values: string[]
): void {
	for (const value of values) {
		for (const segment of value.split(',')) {
			const trimmed = segment.trim();
			if (!trimmed) continue;
			params.append('traits', trimmed);
		}
	}
}

export function parseDisplayMode(raw: string | null): 'grid' | 'table' {
	if (raw?.trim().toLowerCase() === 'table') return 'table';
	return 'grid';
}

export function parseCollectionTokenStatus(raw: string | null): 'listed' | 'all' {
	if (raw?.trim().toLowerCase() === 'all') return 'all';
	return 'listed';
}
