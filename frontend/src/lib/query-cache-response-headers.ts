import { browser } from '$app/environment';
import { QUERY_CACHE_DEBUG_HEADER_NAMES } from '@artgod/shared/config/query-cache-debug';

export type ResponseHeaderSetter = (headers: Record<string, string>) => void;

export const QUERY_CACHE_DEBUG_CONSOLE_STATE_KEY = '__ARTGOD_QUERY_CACHE_DEBUG__';

export type QueryCacheDebugConsoleEntry = {
	url: string;
	headers: Record<string, string>;
	observedAt: string;
};

export type QueryCacheDebugConsoleState = {
	latest: QueryCacheDebugConsoleEntry | null;
	entries: QueryCacheDebugConsoleEntry[];
};

type QueryCacheDebugWindow = Window & {
	__ARTGOD_QUERY_CACHE_DEBUG__?: QueryCacheDebugConsoleState;
};

const QUERY_CACHE_DEBUG_CONSOLE_ENTRY_LIMIT = 25;

// Forward backend cache diagnostics onto SSR page responses for browser inspection.
export function forwardQueryCacheResponseHeaders(
	setHeaders: ResponseHeaderSetter,
	responseHeaders: Headers
): void {
	if (browser) return;
	const headers = extractQueryCacheResponseHeaders(responseHeaders);
	if (Object.keys(headers).length === 0) return;
	setHeaders(headers);
}

// Store browser-side backend cache diagnostics for manual inspection in DevTools.
export function recordQueryCacheResponseHeaders(url: string, responseHeaders: Headers): void {
	if (!browser || typeof window === 'undefined') return;
	const headers = extractQueryCacheResponseHeaders(responseHeaders);
	if (Object.keys(headers).length === 0) return;

	const state = resolveQueryCacheDebugConsoleState();
	const entry = {
		url,
		headers,
		observedAt: new Date().toISOString()
	};
	state.latest = entry;
	state.entries = [entry, ...state.entries].slice(0, QUERY_CACHE_DEBUG_CONSOLE_ENTRY_LIMIT);
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

function resolveQueryCacheDebugConsoleState(): QueryCacheDebugConsoleState {
	const target = window as QueryCacheDebugWindow;
	target[QUERY_CACHE_DEBUG_CONSOLE_STATE_KEY] ??= {
		latest: null,
		entries: []
	};
	return target[QUERY_CACHE_DEBUG_CONSOLE_STATE_KEY];
}
