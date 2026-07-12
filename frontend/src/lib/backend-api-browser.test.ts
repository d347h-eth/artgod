import { ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME } from '@artgod/shared/observability/http';
import { COLLECTION_MEDIA_MODES, COLLECTION_MEDIA_QUERY_PARAMS } from '@artgod/shared/extensions';
import { logger } from '@artgod/shared/utils/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

const TEST_EXTENSION_MEDIA_SOURCE = {
	RequestTime: 'test-request-time'
} as const;

describe('backend api browser mode', () => {
	afterEach(() => {
		vi.doUnmock('$app/environment');
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.resetModules();
	});

	it('does not attach SSR correlation headers or emit SSR logs from browser fetches', async () => {
		vi.doMock('$app/environment', () => ({
			browser: true,
			building: false,
			dev: true,
			version: 'test'
		}));
		vi.stubGlobal('window', {});
		const loggerInfo = vi.spyOn(logger, 'info').mockImplementation(() => {});
		let requestInit: RequestInit | undefined;
		const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			requestInit = init;
			return new Response(JSON.stringify({ chain: { slug: 'ethereum' } }));
		});

		const { getDefaultChain } = await import('./backend-api');
		await getDefaultChain(fetchMock as typeof fetch);

		expect(fetchMock).toHaveBeenCalledWith('/api/chains/default', {
			credentials: 'include'
		});
		expect(new Headers(requestInit?.headers).get(ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME)).toBeNull();
		expect(loggerInfo).not.toHaveBeenCalled();
	});

	it('refreshes the CSRF token and retries one stale browser mutation', async () => {
		vi.doMock('$app/environment', () => ({
			browser: true,
			building: false,
			dev: true,
			version: 'test'
		}));
		vi.stubGlobal('window', {});
		const mutationHeaders: string[] = [];
		let csrfRequests = 0;
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url === '/api/security/csrf') {
				csrfRequests += 1;
				return new Response(
					JSON.stringify({
						token:
							csrfRequests === 1
								? '11111111111111111111111111111111'
								: '22222222222222222222222222222222'
					})
				);
			}
			if (url === '/api/ethereum/terraforms/bidding/jobs/target-lookup') {
				mutationHeaders.push(new Headers(init?.headers).get('x-artgod-csrf') ?? '');
				if (mutationHeaders.length === 1) {
					return new Response(
						JSON.stringify({
							error: 'forbidden',
							message: 'Invalid CSRF token'
						}),
						{ status: 403 }
					);
				}
				return new Response(
					JSON.stringify({
						chain: { slug: 'ethereum' },
						collection: { slug: 'terraforms' },
						job: null
					})
				);
			}
			throw new Error(`unexpected request: ${url}`);
		});

		const { lookupBiddingJobTarget } = await import('./backend-api');
		const response = await lookupBiddingJobTarget(fetchMock as typeof fetch, 'ethereum', 'terraforms', {
			target: {
				type: 'token',
				tokenId: '8733'
			}
		});

		expect(response.job).toBeNull();
		expect(csrfRequests).toBe(2);
		expect(mutationHeaders).toEqual([
			'11111111111111111111111111111111',
			'22222222222222222222222222222222'
		]);
	});

	it('bypasses HTTP cache only for explicit non-snapshot token media requests in the browser', async () => {
		vi.doMock('$app/environment', () => ({
			browser: true,
			building: false,
			dev: true,
			version: 'test'
		}));
		vi.stubGlobal('window', {});
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({}))
		);
		const requestTimeParams = new URLSearchParams({
			[COLLECTION_MEDIA_QUERY_PARAMS.MediaMode]: TEST_EXTENSION_MEDIA_SOURCE.RequestTime
		});
		const snapshotParams = new URLSearchParams({
			[COLLECTION_MEDIA_QUERY_PARAMS.MediaMode]: COLLECTION_MEDIA_MODES.Snapshot
		});
		const { getTokenDetail, getTokenPreview } = await import('./backend-api');

		await getTokenDetail(
			fetchMock as typeof fetch,
			'ethereum',
			'terraforms',
			'1',
			requestTimeParams
		);
		await getTokenPreview(
			fetchMock as typeof fetch,
			'ethereum',
			'terraforms',
			'1',
			requestTimeParams
		);
		await getTokenDetail(fetchMock as typeof fetch, 'ethereum', 'terraforms', '1', snapshotParams);
		await getTokenPreview(fetchMock as typeof fetch, 'ethereum', 'terraforms', '1');

		const requestInits = fetchMock.mock.calls.map((call) => call[1] as RequestInit);
		expect(requestInits[0]?.cache).toBe('no-store');
		expect(requestInits[1]?.cache).toBe('no-store');
		expect(requestInits[2]?.cache).toBeUndefined();
		expect(requestInits[3]?.cache).toBeUndefined();
	});
});
