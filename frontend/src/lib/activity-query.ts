import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { ActivityFeedFilterKind } from '@artgod/shared/types';
import type { ApiTokenAttribute, ApiTraitRangeFilter } from '$lib/api-types';
import { appendMediaModeParam, normalizeMediaMode } from '$lib/media-mode';
import { joinPath, withQuery } from '$lib/route-paths';
import {
	appendNormalizedTraitParams,
	appendNormalizedTraitRangeParams,
	appendTraitParams,
	appendTraitRangeParams
} from '$lib/trait-filters';

export const ACTIVITY_KIND_QUERY_PARAM = 'kind';
export const COLLECTION_ACTIVITY_FILTER_KINDS = ['sales', 'listings', 'transfers'] as const;

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

	params.set(ACTIVITY_KIND_QUERY_PARAM, kind);
	appendMediaModeParam(params, normalizeMediaMode(raw.get('media_mode')));
	appendNormalizedTraitParams(params, raw);
	appendNormalizedTraitRangeParams(params, raw);

	return params;
}

export function buildCollectionActivityQuery(params: {
	limit: number;
	kind: ActivityFeedFilterKind;
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	mediaMode?: string | null;
	cursor?: string | null;
}): URLSearchParams {
	const query = new URLSearchParams();
	query.set('limit', String(params.limit));
	query.set(ACTIVITY_KIND_QUERY_PARAM, params.kind);
	appendMediaModeParam(query, params.mediaMode ?? null);
	if (params.cursor?.trim()) {
		query.set('cursor', params.cursor.trim());
	}
	appendTraitParams(query, params.selectedTraits);
	appendTraitRangeParams(query, params.selectedTraitRanges);
	return query;
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
	const query = buildCollectionActivityQuery({
		limit: params.limit,
		kind: params.kind,
		selectedTraits: params.selectedTraits,
		selectedTraitRanges: params.selectedTraitRanges,
		mediaMode: params.mediaMode ?? null,
		cursor: params.cursor ?? null
	});
	return withQuery(joinPath(params.basePath, 'activity'), query);
}

export function parseCollectionActivityKind(raw: string | null): ActivityFeedFilterKind {
	const normalized = raw?.trim().toLowerCase() as ActivityFeedFilterKind | undefined;
	if (normalized && COLLECTION_ACTIVITY_FILTER_KINDS.includes(normalized)) return normalized;
	return COLLECTION_ACTIVITY_FILTER_KINDS[0];
}
