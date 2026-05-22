import { ARTGOD_SSR_BACKEND_REQUEST_ID_HEADER_NAME } from '@artgod/shared/observability/http';
import { logger } from '@artgod/shared/utils/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
