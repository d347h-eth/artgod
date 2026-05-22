import {
	ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME,
	QUERY_CACHE_DEBUG_HEADER_NAME,
	QUERY_CACHE_DEBUG_STATUSES,
	QUERY_CACHE_DEBUG_TTL_HEADER_NAME
} from '@artgod/shared/observability/http';
import { logger } from '@artgod/shared/utils/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBlockspaceStateWithHeaders, getCollectionDetailWithHeaders } from './backend-api';

describe('backend api observability', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns backend response headers and logs sanitized SSR backend fetches', async () => {
		const loggerInfo = vi.spyOn(logger, 'info').mockImplementation(() => {});
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					chain: {},
					collection: {},
					media: {},
					tokens: {},
					traits: {}
				}),
				{
					headers: {
						[QUERY_CACHE_DEBUG_HEADER_NAME]: QUERY_CACHE_DEBUG_STATUSES.Hit,
						[QUERY_CACHE_DEBUG_TTL_HEADER_NAME]: '60000'
					}
				}
			)
		);
		const params = new URLSearchParams();
		params.set('owner', '0xabc');

		const response = await getCollectionDetailWithHeaders(
			globalThis.fetch,
			'ethereum',
			'terraforms',
			params
		);

		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:3000/api/ethereum/terraforms?owner=0xabc',
			{
				credentials: 'include',
				headers: expect.any(Headers)
			}
		);
		const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
		expect(new Headers(requestInit.headers).get(ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME)).toEqual(
			expect.any(String)
		);
		expect(response.headers.get(QUERY_CACHE_DEBUG_HEADER_NAME)).toBe(QUERY_CACHE_DEBUG_STATUSES.Hit);
		expect(response.headers.get(QUERY_CACHE_DEBUG_TTL_HEADER_NAME)).toBe('60000');
		expect(loggerInfo).toHaveBeenCalledWith(
			'Frontend SSR backend API response',
			expect.objectContaining({
				component: 'FrontendSSR',
				action: 'backend_api_response',
				method: 'GET',
				path: '/api/ethereum/terraforms',
				queryKeys: ['owner'],
				queryParamCount: 1,
				redactedQueryParamCount: 0,
				statusCode: 200,
				queryCacheStatus: QUERY_CACHE_DEBUG_STATUSES.Hit,
				queryCacheAgeMs: null,
				queryCacheTtlMs: 60000,
				responseHeaders: {
					[QUERY_CACHE_DEBUG_HEADER_NAME]: QUERY_CACHE_DEBUG_STATUSES.Hit,
					[QUERY_CACHE_DEBUG_TTL_HEADER_NAME]: '60000'
				}
			})
		);
		expect(loggerInfo.mock.calls[0][1]).not.toMatchObject({
			url: expect.any(String)
		});
	});

	it('keeps blockspace request headers available for SSR page aggregation', async () => {
		vi.spyOn(logger, 'info').mockImplementation(() => {});
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({}), {
				headers: {
					[QUERY_CACHE_DEBUG_HEADER_NAME]: QUERY_CACHE_DEBUG_STATUSES.Miss,
					[QUERY_CACHE_DEBUG_TTL_HEADER_NAME]: '60000'
				}
			})
		);
		const params = new URLSearchParams();
		params.set('collection', 'terraforms');

		const response = await getBlockspaceStateWithHeaders(globalThis.fetch, 'ethereum', params);

		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:3000/api/ethereum/blockspace?collection=terraforms',
			{
				credentials: 'include',
				headers: expect.any(Headers)
			}
		);
		expect(response.headers.get(QUERY_CACHE_DEBUG_HEADER_NAME)).toBe(QUERY_CACHE_DEBUG_STATUSES.Miss);
		expect(response.headers.get(QUERY_CACHE_DEBUG_TTL_HEADER_NAME)).toBe('60000');
	});
});
