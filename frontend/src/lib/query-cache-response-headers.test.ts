import {
	QUERY_CACHE_DEBUG_AGE_HEADER_NAME,
	QUERY_CACHE_DEBUG_HEADER_NAME,
	QUERY_CACHE_DEBUG_TTL_HEADER_NAME
} from '@artgod/shared/config/query-cache-debug';
import { describe, expect, it } from 'vitest';
import {
	extractQueryCacheResponseHeaders,
	forwardQueryCacheResponseHeaders
} from './query-cache-response-headers';

describe('query cache response headers', () => {
	it('extracts only backend query-cache debug headers', () => {
		const headers = new Headers({
			[QUERY_CACHE_DEBUG_HEADER_NAME]: 'hit',
			[QUERY_CACHE_DEBUG_AGE_HEADER_NAME]: '12',
			[QUERY_CACHE_DEBUG_TTL_HEADER_NAME]: '60000',
			'Content-Type': 'application/json'
		});

		expect(extractQueryCacheResponseHeaders(headers)).toEqual({
			[QUERY_CACHE_DEBUG_HEADER_NAME]: 'hit',
			[QUERY_CACHE_DEBUG_AGE_HEADER_NAME]: '12',
			[QUERY_CACHE_DEBUG_TTL_HEADER_NAME]: '60000'
		});
	});

	it('forwards cache debug headers through an SSR setHeaders callback', () => {
		let forwarded: Record<string, string> | null = null;
		forwardQueryCacheResponseHeaders(
			(headers) => {
				forwarded = headers;
			},
			new Headers({
				[QUERY_CACHE_DEBUG_HEADER_NAME]: 'miss',
				[QUERY_CACHE_DEBUG_TTL_HEADER_NAME]: '60000'
			})
		);

		expect(forwarded).toEqual({
			[QUERY_CACHE_DEBUG_HEADER_NAME]: 'miss',
			[QUERY_CACHE_DEBUG_TTL_HEADER_NAME]: '60000'
		});
	});
});
