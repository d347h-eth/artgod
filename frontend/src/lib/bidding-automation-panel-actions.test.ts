import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
	TRADING_BIDDING_BID_SCOPE_KIND,
	TRADING_BIDDING_JOB_PRICING_SOURCE_KIND,
	TRADING_JOB_STATUS,
	TRADING_JOB_TARGET_KIND
} from '@artgod/shared/types';
import type { ApiBiddingBidBookRow, ApiBiddingJob } from '$lib/api-types';
import {
	BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE,
	buildBiddingAutomationDraftFromBid,
	buildBiddingAutomationDraftFromSelection
} from '$lib/bidding-automation';
import { BIDDING_SELECTION_JOB_ACTION } from '$lib/bidding-selection-actions';
import {
	applyBiddingSelectionJobAction,
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

	it('pauses exact selected token jobs through existing pricing without overwriting tiers', async () => {
		const manualJob = testTokenJob({
			jobId: 'job-token-101',
			tokenId: '101',
			floorEth: '0.1',
			ceilingEth: '0.2',
			deltaEth: '0.001',
			pricingSource: null
		});
		const tierJob = testTokenJob({
			jobId: 'job-token-102',
			tokenId: '102',
			floorEth: '0.3',
			ceilingEth: '0.4',
			deltaEth: '0.002',
			pricingSource: {
				kind: TRADING_BIDDING_JOB_PRICING_SOURCE_KIND.PriceTier,
				tierId: 'tier-1',
				tierName: 'tier 1',
				resolvedAt: '2026-01-01T00:00:00Z',
				resolvedFloorWei: '300000000000000000',
				resolvedCeilingWei: '400000000000000000',
				deltaWei: '2000000000000000'
			}
		});
		backendApiMocks.lookupBiddingJobTarget
			.mockResolvedValueOnce({ job: manualJob })
			.mockResolvedValueOnce({ job: tierJob });
		backendApiMocks.upsertTokenBiddingJob
			.mockResolvedValueOnce({
				job: { ...manualJob, status: TRADING_JOB_STATUS.Paused }
			})
			.mockResolvedValueOnce({
				job: { ...tierJob, status: TRADING_JOB_STATUS.Paused }
			});

		const result = await applyBiddingSelectionJobAction({
			fetchFn: testFetch,
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			draft: buildBiddingAutomationDraftFromSelection({
				type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens,
				tokenIds: ['101', '102']
			}),
			action: BIDDING_SELECTION_JOB_ACTION.Pause
		});

		expect(result.jobs).toHaveLength(2);
		expect(backendApiMocks.lookupBiddingJobTarget).toHaveBeenNthCalledWith(
			1,
			testFetch,
			'ethereum',
			'terraforms',
			{
				target: {
					type: 'token',
					tokenId: '101'
				}
			}
		);
		expect(backendApiMocks.upsertTokenBiddingJob).toHaveBeenNthCalledWith(
			1,
			testFetch,
			'ethereum',
			'terraforms',
			'101',
			{
				status: TRADING_JOB_STATUS.Paused,
				floorEth: '0.1',
				ceilingEth: '0.2',
				deltaEth: '0.001',
				priceTierId: null
			}
		);
		expect(backendApiMocks.upsertTokenBiddingJob).toHaveBeenNthCalledWith(
			2,
			testFetch,
			'ethereum',
			'terraforms',
			'102',
			{
				status: TRADING_JOB_STATUS.Paused,
				priceTierId: 'tier-1',
				deltaEth: '0.002'
			}
		);
	});

	it('archives resolved selected jobs through the target-agnostic archive route', async () => {
		const job = testTraitJob();
		const archivedJob = { ...job, status: TRADING_JOB_STATUS.Archived };
		backendApiMocks.lookupBiddingJobTarget.mockResolvedValueOnce({ job });
		backendApiMocks.archiveBiddingJob.mockResolvedValueOnce({ job: archivedJob });

		const result = await applyBiddingSelectionJobAction({
			fetchFn: testFetch,
			chainRef: 'ethereum',
			collectionRef: 'terraforms',
			draft: buildBiddingAutomationDraftFromBid(testTraitBid('1')),
			action: BIDDING_SELECTION_JOB_ACTION.Archive
		});

		expect(result.jobs).toEqual([archivedJob]);
		expect(backendApiMocks.archiveBiddingJob).toHaveBeenCalledWith(
			testFetch,
			'ethereum',
			'terraforms',
			'job-trait-1'
		);
		expect(backendApiMocks.upsertTraitBiddingJob).not.toHaveBeenCalled();
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

function testTokenJob(input: {
	jobId: string;
	tokenId: string;
	floorEth: string;
	ceilingEth: string;
	deltaEth: string;
	pricingSource: ApiBiddingJob['config']['pricingSource'];
}): ApiBiddingJob {
	return {
		jobId: input.jobId,
		status: TRADING_JOB_STATUS.Enabled,
		revision: 1,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T12:00:00Z',
		archivedAt: null,
		target: {
			type: TRADING_JOB_TARGET_KIND.Token,
			tokenId: input.tokenId
		},
		config: {
			floorEth: input.floorEth,
			ceilingEth: input.ceilingEth,
			deltaEth: input.deltaEth,
			pricingSource: input.pricingSource
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
