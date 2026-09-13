import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { ApiOpenSeaIntegrationStatus } from '$lib/api-types';

const backendApi = vi.hoisted(() => ({
	getCollectionsPage: vi.fn(),
	getDefaultChain: vi.fn(),
	getRuntimeConfig: vi.fn()
}));

vi.mock('$lib/backend-api', () => ({
	BackendApiError: class BackendApiError extends Error {
		status = 500;
	},
	getCollectionDetailWithHeaders: vi.fn(),
	getCollectionsPage: backendApi.getCollectionsPage,
	getDefaultChain: backendApi.getDefaultChain,
	getRuntimeConfig: backendApi.getRuntimeConfig
}));

vi.mock('$lib/runtime/public-deployment', () => ({
	IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT: false,
	PUBLIC_COLLECTION_SCOPE: null
}));

vi.mock('$lib/runtime/frontend-target', () => ({
	IS_ADMIN_FRONTEND_TARGET: false
}));

vi.mock('$lib/runtime/initial-load', () => ({
	shouldDeferInitialBackendLoad: vi.fn().mockResolvedValue(false)
}));

import { load } from './+page';

describe('/+page load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns OpenSea integration status with the default-chain collection page', async () => {
		const chain = {
			id: 1,
			type: 'evm',
			publicChainId: 1,
			slug: 'ethereum',
			name: 'Ethereum'
		};
		const openseaIntegration: ApiOpenSeaIntegrationStatus = {
			enabled: true,
			mode: 'enabled',
			reason: null,
			missingKeys: [],
			requiredKeys: []
		};
		backendApi.getDefaultChain.mockResolvedValue({ chain });
		backendApi.getCollectionsPage.mockResolvedValue({
			chain,
			page: {
				items: [],
				nextCursor: null,
				limit: DEFAULT_PAGE_LIMIT
			},
			filters: { status: null }
		});
		backendApi.getRuntimeConfig.mockResolvedValue({
			integrations: { opensea: openseaIntegration },
			blockExplorer: { baseUrl: 'https://etherscan.io' }
		});

		const result = await load({
			fetch: vi.fn(),
			setHeaders: vi.fn(),
			url: new URL('https://artgod.test/')
		} as never);

		expect(result).toMatchObject({
			mode: 'collections',
			chain,
			openseaIntegration
		});
	});
});
