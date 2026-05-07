import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { ActivityFeedFilterKind } from '@artgod/shared/types';
import type {
	ApiActivityExtensionEventRef,
	ApiTokenAttribute,
	ApiTraitRangeFilter
} from '$lib/api-types';
import { appendMediaModeParam, normalizeMediaMode } from '$lib/media-mode';
import { joinPath, withQuery } from '$lib/route-paths';
import {
	appendNormalizedTraitParams,
	appendNormalizedTraitRangeParams,
	appendTraitParams,
	appendTraitRangeParams
} from '$lib/trait-filters';

export const ACTIVITY_KIND_QUERY_PARAM = 'kind';
export const ACTIVITY_EXTENSION_EVENT_QUERY_PARAM = 'extension_event';
export const ACTIVITY_TOKEN_ID_QUERY_PARAM = 'token_id';
export const ACTIVITY_MAKER_QUERY_PARAM = 'maker';
export const ACTIVITY_CONTENT_HASH_QUERY_PARAM = 'content_hash';
export const COLLECTION_ACTIVITY_FILTER_KINDS = ['sales', 'listings', 'transfers'] as const;

export type CollectionActivitySelection =
	| { kind: ActivityFeedFilterKind; extensionEvent?: null }
	| { kind?: null; extensionEvent: ApiActivityExtensionEventRef };

export function normalizeCollectionActivityParams(
	raw: URLSearchParams,
	selection: CollectionActivitySelection
): URLSearchParams {
	const params = new URLSearchParams();

	const limit = raw.get('limit');
	params.set('limit', limit && /^\d+$/.test(limit) ? limit : String(DEFAULT_PAGE_LIMIT));

	const cursor = raw.get('cursor');
	if (cursor && cursor.trim()) {
		params.set('cursor', cursor.trim());
	}

	if (selection.extensionEvent) {
		params.set(ACTIVITY_EXTENSION_EVENT_QUERY_PARAM, formatActivityExtensionEventRef(selection.extensionEvent));
	} else {
		params.set(ACTIVITY_KIND_QUERY_PARAM, selection.kind);
	}
	appendMediaModeParam(params, normalizeMediaMode(raw.get('media_mode')));
	appendNormalizedTraitParams(params, raw);
	appendNormalizedTraitRangeParams(params, raw);
	appendOptionalActivityFilter(params, ACTIVITY_TOKEN_ID_QUERY_PARAM, raw.get(ACTIVITY_TOKEN_ID_QUERY_PARAM));
	appendOptionalActivityFilter(params, ACTIVITY_MAKER_QUERY_PARAM, raw.get(ACTIVITY_MAKER_QUERY_PARAM));
	appendOptionalActivityFilter(params, ACTIVITY_CONTENT_HASH_QUERY_PARAM, raw.get(ACTIVITY_CONTENT_HASH_QUERY_PARAM));

	return params;
}

export function buildCollectionActivityQuery(params: {
	limit: number;
	kind?: ActivityFeedFilterKind | null;
	extensionEvent?: ApiActivityExtensionEventRef | null;
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	mediaMode?: string | null;
	cursor?: string | null;
	tokenId?: string | null;
	maker?: string | null;
	contentHash?: string | null;
}): URLSearchParams {
	const query = new URLSearchParams();
	query.set('limit', String(params.limit));
	if (params.extensionEvent) {
		query.set(ACTIVITY_EXTENSION_EVENT_QUERY_PARAM, formatActivityExtensionEventRef(params.extensionEvent));
	} else {
		query.set(ACTIVITY_KIND_QUERY_PARAM, params.kind ?? COLLECTION_ACTIVITY_FILTER_KINDS[0]);
	}
	appendMediaModeParam(query, params.mediaMode ?? null);
	if (params.cursor?.trim()) {
		query.set('cursor', params.cursor.trim());
	}
	appendOptionalActivityFilter(query, ACTIVITY_TOKEN_ID_QUERY_PARAM, params.tokenId);
	appendOptionalActivityFilter(query, ACTIVITY_MAKER_QUERY_PARAM, params.maker);
	appendOptionalActivityFilter(query, ACTIVITY_CONTENT_HASH_QUERY_PARAM, params.contentHash);
	appendTraitParams(query, params.selectedTraits);
	appendTraitRangeParams(query, params.selectedTraitRanges);
	return query;
}

export function buildCollectionActivityHref(params: {
	basePath: string;
	limit: number;
	kind?: ActivityFeedFilterKind | null;
	extensionEvent?: ApiActivityExtensionEventRef | null;
	selectedTraits: ApiTokenAttribute[];
	selectedTraitRanges: ApiTraitRangeFilter[];
	mediaMode?: string | null;
	cursor?: string | null;
	tokenId?: string | null;
	maker?: string | null;
	contentHash?: string | null;
}): string {
	const query = buildCollectionActivityQuery({
		limit: params.limit,
		kind: params.kind ?? null,
		extensionEvent: params.extensionEvent ?? null,
		selectedTraits: params.selectedTraits,
		selectedTraitRanges: params.selectedTraitRanges,
		mediaMode: params.mediaMode ?? null,
		cursor: params.cursor ?? null,
		tokenId: params.tokenId ?? null,
		maker: params.maker ?? null,
		contentHash: params.contentHash ?? null
	});
	return withQuery(joinPath(params.basePath, 'activity'), query);
}

export function parseCollectionActivityKind(raw: string | null): ActivityFeedFilterKind {
	const normalized = raw?.trim().toLowerCase() as ActivityFeedFilterKind | undefined;
	if (normalized && COLLECTION_ACTIVITY_FILTER_KINDS.includes(normalized)) return normalized;
	return COLLECTION_ACTIVITY_FILTER_KINDS[0];
}

export function parseCollectionActivityExtensionEvent(
	raw: string | null
): ApiActivityExtensionEventRef | null {
	if (!raw?.trim()) return null;
	const [extensionKey, eventKey, extra] = raw.trim().split(':');
	if (extra !== undefined || !extensionKey || !eventKey) return null;
	return { extensionKey, eventKey };
}

export function formatActivityExtensionEventRef(input: ApiActivityExtensionEventRef): string {
	return `${input.extensionKey}:${input.eventKey}`;
}

function appendOptionalActivityFilter(
	params: URLSearchParams,
	key: string,
	value: string | null | undefined
): void {
	if (value?.trim()) {
		params.set(key, value.trim());
	}
}
