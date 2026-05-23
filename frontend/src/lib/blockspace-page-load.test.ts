import {
	QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME,
	QUERY_CACHE_DEBUG_HEADER_NAME,
	QUERY_CACHE_DEBUG_STATUSES
} from '@artgod/shared/observability/http';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('public blockspace page load', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
		vi.doUnmock('$lib/backend-api');
		vi.doUnmock('$lib/runtime/public-deployment');
	});

	it('forwards one aggregate cache state for all backend calls used by the SSR page', async () => {
		const blockspaceStates = [
			createBlockspaceState(),
			createBlockspaceState({
				fromBlock: 24_117_248,
				toBlock: 25_165_823,
				bucketSize: 1024
			})
		];
		const stateStatuses = [
			QUERY_CACHE_DEBUG_STATUSES.Hit,
			QUERY_CACHE_DEBUG_STATUSES.Miss
		];
		vi.doMock('$lib/runtime/public-deployment', () => ({
			IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT: true,
			PUBLIC_COLLECTION_SCOPE: {
				chainRef: 'ethereum',
				collectionRef: 'terraforms'
			},
			publicCollectionBlockspacePath: () => '/blockspace'
		}));
		vi.doMock('$lib/backend-api', () => ({
			BackendApiError: class BackendApiError extends Error {
				constructor(
					message: string,
					public status: number
				) {
					super(message);
				}
			},
			getBlockspaceStateWithHeaders: vi.fn(async () => {
				const payload = blockspaceStates.shift() ?? createBlockspaceState();
				const status = stateStatuses.shift() ?? QUERY_CACHE_DEBUG_STATUSES.Hit;
				return {
					payload,
					headers: new Headers({
						[QUERY_CACHE_DEBUG_HEADER_NAME]: status,
						[QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME]: '1'
					})
				};
			}),
			getCollectionDetailWithHeaders: vi.fn(async () => ({
				payload: {
					collection: {
						slug: 'terraforms'
					}
				},
				headers: new Headers({
					[QUERY_CACHE_DEBUG_HEADER_NAME]: QUERY_CACHE_DEBUG_STATUSES.Bypass,
					[QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME]: '1'
				})
			}))
		}));
		const { load } = await import('../routes/blockspace/+page');
		const setHeaders = vi.fn();

		const result = await load({
			fetch: globalThis.fetch,
			setHeaders,
			url: new URL('http://artgod.local/blockspace?stack=24117248:1024')
		} as never);

		expect(result).toMatchObject({
			collection: 'terraforms',
			basePath: '/blockspace'
		});
		expect(setHeaders).toHaveBeenCalledTimes(1);
		expect(setHeaders).toHaveBeenCalledWith({
			[QUERY_CACHE_DEBUG_HEADER_NAME]: QUERY_CACHE_DEBUG_STATUSES.Mixed,
			[QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME]: '3'
		});
	});
});

describe('standard blockspace page load', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
		vi.doUnmock('$lib/backend-api');
		vi.doUnmock('$lib/runtime/frontend-target');
		vi.doUnmock('$lib/runtime/public-deployment');
	});

	it('forwards one aggregate cache state for all visible stack backend calls', async () => {
		const blockspaceStates = [
			createBlockspaceState(),
			createBlockspaceState({
				fromBlock: 24_117_248,
				toBlock: 25_165_823,
				bucketSize: 1024
			})
		];
		const stateStatuses = [
			QUERY_CACHE_DEBUG_STATUSES.Hit,
			QUERY_CACHE_DEBUG_STATUSES.Miss
		];
		vi.doMock('$lib/runtime/public-deployment', () => ({
			IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT: false
		}));
		vi.doMock('$lib/runtime/frontend-target', () => ({
			IS_ADMIN_FRONTEND_TARGET: false
		}));
		vi.doMock('$lib/backend-api', () => ({
			BackendApiError: class BackendApiError extends Error {
				constructor(
					message: string,
					public status: number
				) {
					super(message);
				}
			},
			getBlockspaceStateWithHeaders: vi.fn(async () => {
				const payload = blockspaceStates.shift() ?? createBlockspaceState();
				const status = stateStatuses.shift() ?? QUERY_CACHE_DEBUG_STATUSES.Hit;
				return {
					payload,
					headers: new Headers({
						[QUERY_CACHE_DEBUG_HEADER_NAME]: status,
						[QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME]: '1'
					})
				};
			})
		}));
		const { load } = await import('../routes/[chain_ref]/blockspace/+page');
		const setHeaders = vi.fn();

		const result = await load({
			fetch: globalThis.fetch,
			params: {
				chain_ref: 'ethereum'
			},
			setHeaders,
			url: new URL('http://artgod.local/ethereum/blockspace?collection=terraforms&stack=24117248:1024')
		} as never);

		expect(result).toMatchObject({
			collection: 'terraforms',
			basePath: '/ethereum/blockspace'
		});
		expect(setHeaders).toHaveBeenCalledTimes(1);
		expect(setHeaders).toHaveBeenCalledWith({
			[QUERY_CACHE_DEBUG_HEADER_NAME]: QUERY_CACHE_DEBUG_STATUSES.Mixed,
			[QUERY_CACHE_DEBUG_EVENT_COUNT_HEADER_NAME]: '2'
		});
	});
});

function createBlockspaceState(
	range: {
		fromBlock: number;
		toBlock: number;
		bucketSize: number;
	} = {
		fromBlock: 0,
		toBlock: 1023,
		bucketSize: 1024
	}
): unknown {
	return {
		chain: {
			slug: 'ethereum',
			name: 'Ethereum',
			publicChainId: 1,
			averageBlockTimeSeconds: 12
		},
		range: {
			fromBlock: range.fromBlock,
			toBlock: range.toBlock,
			blockCount: range.toBlock - range.fromBlock + 1,
			bucketSize: range.bucketSize,
			time: {
				from: null,
				to: null,
				durationSeconds: 0
			}
		},
		summary: {
			selectedRangeSyncedBlockCount: 0
		},
		context: {
			selected: 'terraforms',
			collections: []
		},
		grid: []
	};
}
