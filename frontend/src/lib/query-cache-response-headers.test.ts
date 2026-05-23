import {
	QUERY_CACHE_DEBUG_AGE_HEADER_NAME,
	QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME,
	QUERY_CACHE_DEBUG_HEADER_NAME,
	QUERY_CACHE_DEBUG_STATUSES,
	QUERY_CACHE_DEBUG_TTL_HEADER_NAME,
	sanitizeHttpRequestTarget
} from '@artgod/shared/observability/http';
import { describe, expect, it } from 'vitest';
import {
	aggregateQueryCacheResponseHeaders,
	extractQueryCacheResponseHeaders
} from './query-cache-response-headers';

describe('query cache response headers', () => {
	it('extracts only backend query-cache debug headers', () => {
		const headers = new Headers({
			[QUERY_CACHE_DEBUG_HEADER_NAME]: QUERY_CACHE_DEBUG_STATUSES.Hit,
			[QUERY_CACHE_DEBUG_AGE_HEADER_NAME]: '12',
			[QUERY_CACHE_DEBUG_TTL_HEADER_NAME]: '60000',
			[QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME]: '1',
			'Content-Type': 'application/json'
		});

		expect(extractQueryCacheResponseHeaders(headers)).toEqual({
			[QUERY_CACHE_DEBUG_HEADER_NAME]: QUERY_CACHE_DEBUG_STATUSES.Hit,
			[QUERY_CACHE_DEBUG_AGE_HEADER_NAME]: '12',
			[QUERY_CACHE_DEBUG_TTL_HEADER_NAME]: '60000',
			[QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME]: '1'
		});
	});

	it('aggregates multi-fetch SSR cache headers without hiding mixed state', () => {
		const aggregate = aggregateQueryCacheResponseHeaders([
			new Headers({
				[QUERY_CACHE_DEBUG_HEADER_NAME]: QUERY_CACHE_DEBUG_STATUSES.Hit,
				[QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME]: '1',
				[QUERY_CACHE_DEBUG_AGE_HEADER_NAME]: '10',
				[QUERY_CACHE_DEBUG_TTL_HEADER_NAME]: '60000'
			}),
			new Headers({
				[QUERY_CACHE_DEBUG_HEADER_NAME]: QUERY_CACHE_DEBUG_STATUSES.Bypass,
				[QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME]: '1'
			})
		]);

		expect(aggregate).toEqual({
			[QUERY_CACHE_DEBUG_HEADER_NAME]: QUERY_CACHE_DEBUG_STATUSES.Mixed,
			[QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME]: '2'
		});
	});

	it('sanitizes request targets without retaining query values or origins', () => {
		expect(
			sanitizeHttpRequestTarget(
				'http://127.0.0.1:3000/api/ethereum/terraforms?owner=0xabc&cursor=secret&0xsecret=value'
			)
		).toEqual({
			path: '/api/ethereum/terraforms',
			queryKeys: ['cursor', 'owner'],
			queryParamCount: 3,
			redactedQueryParamCount: 1
		});
	});
});
