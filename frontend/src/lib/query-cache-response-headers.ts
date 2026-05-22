import { browser } from '$app/environment';
import {
	QUERY_CACHE_DEBUG_AGE_HEADER_NAME,
	QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME,
	QUERY_CACHE_DEBUG_HEADER_NAME,
	QUERY_CACHE_DEBUG_HEADER_NAMES,
	QUERY_CACHE_DEBUG_STATUSES,
	QUERY_CACHE_DEBUG_TTL_HEADER_NAME
} from '@artgod/shared/observability/http';

export type ResponseHeaderSetter = (headers: Record<string, string>) => void;

// Forward aggregated backend cache diagnostics onto SSR page responses.
export function forwardQueryCacheResponseHeaders(
	setHeaders: ResponseHeaderSetter,
	responseHeaders: Headers | Headers[]
): void {
	if (browser) return;
	const headers = aggregateQueryCacheResponseHeaders(
		Array.isArray(responseHeaders) ? responseHeaders : [responseHeaders]
	);
	if (Object.keys(headers).length === 0) return;
	setHeaders(headers);
}

// Extract only the stable cache-debug headers from a backend response.
export function extractQueryCacheResponseHeaders(
	responseHeaders: Headers
): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const headerName of QUERY_CACHE_DEBUG_HEADER_NAMES) {
		const value = responseHeaders.get(headerName);
		if (value !== null) {
			headers[headerName] = value;
		}
	}
	return headers;
}

export function aggregateQueryCacheResponseHeaders(responseHeaders: Headers[]): Record<string, string> {
	const entries = responseHeaders
		.map(extractQueryCacheResponseHeaders)
		.filter((headers) => headers[QUERY_CACHE_DEBUG_HEADER_NAME]);
	if (entries.length === 0) return {};

	const statuses = new Set(entries.map((headers) => headers[QUERY_CACHE_DEBUG_HEADER_NAME]));
	const status =
		statuses.size === 1 ? entries[0][QUERY_CACHE_DEBUG_HEADER_NAME] : QUERY_CACHE_DEBUG_STATUSES.Mixed;
	const eventCount = entries.reduce((sum, headers) => {
		return sum + (parseOptionalInteger(headers[QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME]) ?? 1);
	}, 0);
	const aggregate: Record<string, string> = {
		[QUERY_CACHE_DEBUG_HEADER_NAME]: status,
		[QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME]: String(eventCount)
	};
	if (status !== QUERY_CACHE_DEBUG_STATUSES.Mixed) {
		const ageMs = aggregateNumericHeader(entries, QUERY_CACHE_DEBUG_AGE_HEADER_NAME, 'max');
		const ttlMs = aggregateNumericHeader(entries, QUERY_CACHE_DEBUG_TTL_HEADER_NAME, 'min');
		if (ageMs !== null) aggregate[QUERY_CACHE_DEBUG_AGE_HEADER_NAME] = String(ageMs);
		if (ttlMs !== null) aggregate[QUERY_CACHE_DEBUG_TTL_HEADER_NAME] = String(ttlMs);
	}
	return aggregate;
}

function aggregateNumericHeader(
	entries: Record<string, string>[],
	headerName: string,
	mode: 'min' | 'max'
): number | null {
	const values = entries
		.map((headers) => parseOptionalInteger(headers[headerName]))
		.filter((value): value is number => value !== null);
	if (values.length === 0) return null;
	return mode === 'min' ? Math.min(...values) : Math.max(...values);
}

function parseOptionalInteger(value: string | undefined): number | null {
	if (!value) return null;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : null;
}
