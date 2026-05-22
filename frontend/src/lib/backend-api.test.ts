import {
	QUERY_CACHE_DEBUG_HEADER_NAME,
	QUERY_CACHE_DEBUG_TTL_HEADER_NAME
} from '@artgod/shared/config/query-cache-debug';
import { ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME } from '@artgod/shared/observability/http';
import { logger } from '@artgod/shared/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBlockspaceStateWithHeaders, getCollectionDetailWithHeaders } from './backend-api';

describe('backend api response headers', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns backend response headers for collection detail requests', async () => {
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
						[QUERY_CACHE_DEBUG_HEADER_NAME]: 'hit',
						[QUERY_CACHE_DEBUG_TTL_HEADER_NAME]: '60000'
					}
				}
			)
		);

		const response = await getCollectionDetailWithHeaders(
			globalThis.fetch,
			'ethereum',
			'terraforms',
			new URLSearchParams()
		);

		expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:3000/api/ethereum/terraforms', {
			credentials: 'include',
			headers: expect.any(Headers)
		});
		const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
		expect(new Headers(requestInit.headers).get(ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME)).toEqual(
			expect.any(String)
		);
		expect(response.headers.get(QUERY_CACHE_DEBUG_HEADER_NAME)).toBe('hit');
		expect(response.headers.get(QUERY_CACHE_DEBUG_TTL_HEADER_NAME)).toBe('60000');
		expect(loggerInfo).toHaveBeenCalledWith(
			'Frontend SSR backend API response',
			expect.objectContaining({
				component: 'FrontendSSR',
				action: 'backend_api_response',
				method: 'GET',
				url: 'http://127.0.0.1:3000/api/ethereum/terraforms',
				statusCode: 200,
				queryCacheStatus: 'hit',
				queryCacheAgeMs: null,
				queryCacheTtlMs: 60000,
				responseHeaders: {
					[QUERY_CACHE_DEBUG_HEADER_NAME]: 'hit',
					[QUERY_CACHE_DEBUG_TTL_HEADER_NAME]: '60000'
				}
			})
		);
	});

	it('returns backend response headers for blockspace requests', async () => {
		vi.spyOn(logger, 'info').mockImplementation(() => {});
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({}), {
				headers: {
					[QUERY_CACHE_DEBUG_HEADER_NAME]: 'miss',
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
		const requestInit = fetchMock.mock.calls[0][1] as RequestInit;
		expect(new Headers(requestInit.headers).get(ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME)).toEqual(
			expect.any(String)
		);
		expect(response.headers.get(QUERY_CACHE_DEBUG_HEADER_NAME)).toBe('miss');
		expect(response.headers.get(QUERY_CACHE_DEBUG_TTL_HEADER_NAME)).toBe('60000');
	});
});
