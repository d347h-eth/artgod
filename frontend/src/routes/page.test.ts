import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { ApiOpenSeaIntegrationStatus } from '$lib/api-types';

const backendApi = vi.hoisted(() => ({
	getCollectionDetailWithHeaders: vi.fn(),
	getCollectionsPage: vi.fn(),
	getDefaultChain: vi.fn(),
	getRuntimeConfig: vi.fn()
}));

const frontend = vi.hoisted(() => ({
	isAdmin: false,
	isPublic: false,
	scope: null as { chainRef: string; collectionRef: string } | null
}));

vi.mock('$lib/backend-api', () => ({
	BackendApiError: class BackendApiError extends Error {
		status = 500;
	},
	getCollectionDetailWithHeaders: backendApi.getCollectionDetailWithHeaders,
	getCollectionsPage: backendApi.getCollectionsPage,
	getDefaultChain: backendApi.getDefaultChain,
	getRuntimeConfig: backendApi.getRuntimeConfig
}));

vi.mock('$lib/runtime/public-deployment', () => ({
	get IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT() {
		return frontend.isPublic;
	},
	get PUBLIC_COLLECTION_SCOPE() {
		return frontend.scope;
	}
}));

vi.mock('$lib/runtime/frontend-target', () => ({
	get IS_ADMIN_FRONTEND_TARGET() {
		return frontend.isAdmin;
	}
}));

vi.mock('$lib/runtime/initial-load', () => ({
	shouldDeferInitialBackendLoad: vi.fn().mockResolvedValue(false)
}));

import { load } from './+page';

describe('/+page load', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		frontend.isAdmin = false;
		frontend.isPublic = false;
		frontend.scope = null;
	});

	it.each([false, true])(
		'does not load backend data for Admin with public mode %s',
		async (isPublic) => {
			frontend.isAdmin = true;
			frontend.isPublic = isPublic;
			frontend.scope = { chainRef: 'example-chain', collectionRef: 'example-collection' };
			const result = await load({
				fetch: vi.fn(),
				setHeaders: vi.fn(),
				url: new URL('https://artgod.test/')
			} as never);

			expect(result).toMatchObject({ mode: 'collections', chain: null, deferred: false });
			for (const request of Object.values(backendApi)) {
				expect(request).not.toHaveBeenCalled();
			}
		}
	);

	it('loads the configured collection for public Userland', async () => {
		frontend.isPublic = true;
		frontend.scope = { chainRef: 'example-chain', collectionRef: 'example-collection' };
		const fetch = vi.fn();
		const collection = { name: 'Example collection' };
		backendApi.getCollectionDetailWithHeaders.mockResolvedValue({
			payload: {
				chain: { slug: frontend.scope.chainRef },
				collection,
				tokens: { items: [] },
				traits: { facets: [], selected: [], selectedRanges: [] }
			},
			headers: new Headers()
		});
		backendApi.getRuntimeConfig.mockResolvedValue({ blockExplorer: null });
		const result = await load({
			fetch,
			setHeaders: vi.fn(),
			url: new URL('https://artgod.test/')
		} as never);

		expect(result).toMatchObject({ mode: 'public_collection', collection, basePath: '/' });
		expect(backendApi.getCollectionDetailWithHeaders).toHaveBeenCalledWith(
			fetch,
			frontend.scope.chainRef,
			frontend.scope.collectionRef,
			expect.any(URLSearchParams)
		);
		expect(backendApi.getDefaultChain).not.toHaveBeenCalled();
		expect(backendApi.getCollectionsPage).not.toHaveBeenCalled();
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
