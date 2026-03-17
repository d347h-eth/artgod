import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { TokenBrowserStatus } from '@artgod/shared/types/browse';

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
	for (const value of traitValues) {
		for (const segment of value.split(',')) {
			const trimmed = segment.trim();
			if (!trimmed) continue;
			params.append('traits', trimmed);
		}
	}

	return params;
}

export function parseDisplayMode(raw: string | null): 'grid' | 'table' {
	if (raw?.trim().toLowerCase() === 'table') return 'table';
	return 'grid';
}

export function parseCollectionTokenStatus(raw: string | null): 'listed' | 'all' {
	if (raw?.trim().toLowerCase() === 'all') return 'all';
	return 'listed';
}
