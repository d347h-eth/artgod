import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { ActivityFeedFilterKind } from '@artgod/shared/types';
import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';
import { appendMediaModeParam, normalizeMediaMode } from '$lib/media-mode';
import {
	appendNormalizedTraitParams,
	appendNormalizedTraitRangeParams,
	appendTraitParams,
	appendTraitRangeParams
} from '$lib/trait-filters';

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
	appendMediaModeParam(params, normalizeMediaMode(raw.get('media_mode')));
	appendNormalizedTraitParams(params, raw);
	appendNormalizedTraitRangeParams(params, raw);

	return params;
}

export function buildCollectionActivityHref(params: {
	basePath: string;
	limit: number;
	kind: ActivityFeedFilterKind;
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	mediaMode?: string | null;
	cursor?: string | null;
}): string {
	const query = new URLSearchParams();
	query.set('limit', String(params.limit));
	query.set('kind', params.kind);
	appendMediaModeParam(query, params.mediaMode ?? null);
	if (params.cursor?.trim()) {
		query.set('cursor', params.cursor.trim());
	}
	appendTraitParams(query, params.selectedTraits);
	appendTraitRangeParams(query, params.selectedTraitRanges);
	return `${params.basePath}/activity?${query.toString()}`;
}

export function parseCollectionActivityKind(raw: string | null): ActivityFeedFilterKind {
	if (raw?.trim().toLowerCase() === 'listings') return 'listings';
	if (raw?.trim().toLowerCase() === 'transfers') return 'transfers';
	return 'sales';
}
