import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { ActivityFeedFilterKind } from '@artgod/shared/types';

export function normalizeCollectionActivityParams(
	raw: URLSearchParams,
	kind: ActivityFeedFilterKind
): URLSearchParams {
	const params = new URLSearchParams();

	const limit = raw.get('limit');
	params.set('limit', limit && /^\d+$/.test(limit) ? limit : String(DEFAULT_PAGE_LIMIT));

	const cursor = raw.get('cursor');
	if (cursor && cursor.trim()) {
		params.set('cursor', cursor.trim());
	}

	params.set('kind', kind);

	return params;
}

export function parseCollectionActivityKind(raw: string | null): ActivityFeedFilterKind {
	if (raw?.trim().toLowerCase() === 'listings') return 'listings';
	if (raw?.trim().toLowerCase() === 'transfers') return 'transfers';
	return 'sales';
}
