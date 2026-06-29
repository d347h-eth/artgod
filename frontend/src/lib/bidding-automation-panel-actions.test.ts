import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
	TRADING_BIDDING_BID_SCOPE_KIND,
	TRADING_JOB_STATUS,
	TRADING_JOB_TARGET_KIND
} from '@artgod/shared/types';
import type { ApiBiddingBidBookRow, ApiBiddingJob } from '$lib/api-types';
import { buildBiddingAutomationDraftFromBid } from '$lib/bidding-automation';
import {
	lookupBiddingAutomationDraftTargetJob,
	resolveBiddingAutomationDraftTargetLookupKey,
	saveBiddingAutomationDraftJobs
} from '$lib/bidding-automation-panel-actions';

const backendApiMocks = vi.hoisted(() => ({
	archiveBiddingJob: vi.fn(),
	lookupBiddingJobTarget: vi.fn(),
	upsertBatchTokenBiddingJobs: vi.fn(),
	upsertCollectionBiddingJob: vi.fn(),
	upsertTokenBiddingJob: vi.fn(),
	upsertTraitBiddingJob: vi.fn()
}));

vi.mock('$lib/backend-api', () => backendApiMocks);

const testFetch = vi.fn() as unknown as typeof fetch;

function exactPrice(wei: string, eth: string): ApiBiddingBidBookRow['price'] {
	return {
		kind: 'exact',
		wei,
		eth
	};
}

describe('bidding automation panel actions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('routes selected trait bids through the trait job mutation with selected quantity', async () => {
		const job = testTraitJob();
		backendApiMocks.upsertTraitBiddingJob.mockResolvedValueOnce({ job });
		const draft = buildBiddingAutomationDraftFromBid(testTraitBid('2'));

		const changedJobs = await saveBiddingAutomationDraftJobs({
			fetchFn: testFetch,
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			draft,
			targetTokenId: null,
			nextStatus: TRADING_JOB_STATUS.Enabled,
			pricing: {
				floorEth: '0.351',
				ceilingEth: '0.5',
				deltaEth: '0.001',
				priceTierId: null
			}
		});

		expect(changedJobs).toEqual([job]);
		expect(backendApiMocks.upsertTraitBiddingJob).toHaveBeenCalledWith(
			testFetch,
			'ethereum',
			'terraforms',
			{
				status: TRADING_JOB_STATUS.Enabled,
				floorEth: '0.351',
				ceilingEth: '0.5',
				deltaEth: '0.001',
				priceTierId: null,
				quantity: 2,
				targetTraits: [
					{ type: 'Biome', value: '42' },
					{ type: 'Mode', value: 'Terrain' }
				]
			}
		);
		expect(backendApiMocks.upsertTokenBiddingJob).not.toHaveBeenCalled();
		expect(backendApiMocks.upsertBatchTokenBiddingJobs).not.toHaveBeenCalled();
		expect(backendApiMocks.upsertCollectionBiddingJob).not.toHaveBeenCalled();
	});

	it('dedupes and performs declared job lookup for selected bid drafts', async () => {
		const draft = buildBiddingAutomationDraftFromBid(testTraitBid('1'));
		const job = testTraitJob();
		backendApiMocks.lookupBiddingJobTarget.mockResolvedValueOnce({ job });

		const lookupKey = resolveBiddingAutomationDraftTargetLookupKey({
			chain: testChain(),
			collection: testCollection(),
			draft
		});
		const lookedUpJob = await lookupBiddingAutomationDraftTargetJob({
			fetchFn: testFetch,
			chain: testChain(),
			collection: testCollection(),
			draft
		});

		expect(lookupKey).toContain('ethereum:terraforms:');
		expect(lookedUpJob).toBe(job);
		expect(backendApiMocks.lookupBiddingJobTarget).toHaveBeenCalledWith(
			testFetch,
			'ethereum',
			'terraforms',
			{
				target: {
					type: 'trait',
					quantity: 1,
					targetTraits: [
						{ type: 'Biome', value: '42' },
						{ type: 'Mode', value: 'Terrain' }
					]
				}
			}
		);
	});
});

function testTraitBid(quantity: string): ApiBiddingBidBookRow {
	return {
		orderId: '0xtrait-bid',
		source: 'orders',
		materialization: {
			kind: TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid,
			jobId: null,
			status: null,
			phase: null
		},
		scope: {
			kind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
			label: 'Biome=42 + Mode=Terrain',
			tokenId: null,
			traits: [
				{ type: 'Biome', value: '42' },
				{ type: 'Mode', value: 'Terrain' }
			]
		},
		maker: {
			address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			label: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			isOwn: false
		},
		price: exactPrice('350000000000000000', '0.35'),
		bidLimits: null,
		quantity,
		currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
		currencySymbol: 'WETH',
		protocolAddress: null,
		validUntil: 1_900_000_000,
		placedAt: '2026-01-02T00:00:00Z',
		snapshotRefreshedAtMs: null,
		seenAt: '2026-01-02T00:00:00Z',
		ownStatus: null
	};
}

function testTraitJob(): ApiBiddingJob {
	return {
		jobId: 'job-trait-1',
		status: TRADING_JOB_STATUS.Enabled,
		revision: 2,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T12:00:00Z',
		archivedAt: null,
		target: {
			type: TRADING_JOB_TARGET_KIND.Collection,
			quantity: 1,
			targetTraits: [
				{ type: 'Biome', value: '42' },
				{ type: 'Mode', value: 'Terrain' }
			]
		},
		config: {
			floorEth: '0.351',
			ceilingEth: '0.5',
			deltaEth: '0.001',
			pricingSource: null
		},
		runtime: null
	};
}

function testChain() {
	return {
		id: 1,
		type: 'evm' as const,
		publicChainId: 1,
		slug: 'ethereum',
		name: 'Ethereum'
	};
}

function testCollection() {
	return {
		chainId: 1,
		collectionId: 1,
		slug: 'terraforms',
		address: '0x4e1f41613c9084fdb9e34e11fae9412427480e56',
		standard: 'erc721' as const,
		status: 'live' as const,
		deploymentBlock: 1,
		bootstrapAnchorBlock: null,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z'
	};
}
