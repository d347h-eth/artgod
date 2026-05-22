import {
	QUERY_CACHE_DEBUG_HEADER_NAME,
	QUERY_CACHE_DEBUG_TTL_HEADER_NAME
} from '@artgod/shared/config/query-cache-debug';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBlockspaceStateWithHeaders, getCollectionDetailWithHeaders } from './backend-api';

describe('backend api response headers', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('returns backend response headers for collection detail requests', async () => {
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
			credentials: 'include'
		});
		expect(response.headers.get(QUERY_CACHE_DEBUG_HEADER_NAME)).toBe('hit');
		expect(response.headers.get(QUERY_CACHE_DEBUG_TTL_HEADER_NAME)).toBe('60000');
	});

	it('returns backend response headers for blockspace requests', async () => {
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
			{ credentials: 'include' }
		);
		expect(response.headers.get(QUERY_CACHE_DEBUG_HEADER_NAME)).toBe('miss');
		expect(response.headers.get(QUERY_CACHE_DEBUG_TTL_HEADER_NAME)).toBe('60000');
	});
});

