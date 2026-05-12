import { describe, expect, it } from 'vitest';
import type { ApiBiddingBidBookRow, ApiBiddingJob } from '$lib/api-types';
import {
	BIDDING_AUTOMATION_DRAFT_TARGET_TYPE,
	BIDDING_AUTOMATION_FILTER_SELECTION_STATE,
	BIDDING_AUTOMATION_FILTER_TARGET_INTENT,
	BIDDING_AUTOMATION_PRICING_MODE,
	BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE,
	BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE,
	biddingAutomationDraftTokenId,
	buildBiddingAutomationDraftFromBid,
	buildBiddingAutomationDraftFromSelection,
	isBiddingAutomationDraftSubmittable
} from '$lib/bidding-automation';

const BASE_BID: ApiBiddingBidBookRow = {
	orderId: '0xbase',
	source: 'orders',
	scope: {
		kind: 'collection',
		label: 'collection',
		tokenId: null,
		traits: []
	},
	maker: {
		address: '0x1111111111111111111111111111111111111111',
		label: '0x1111111111111111111111111111111111111111',
		isOwn: false
	},
	priceWei: '300000000000000000',
	priceEth: '0.3',
	quantity: '1',
	currencyAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
	currencySymbol: 'WETH',
	protocolAddress: null,
	validUntil: 1_900_000_000,
	placedAt: '2026-01-02T00:00:00Z',
	snapshotRefreshedAtMs: null,
	seenAt: '2026-01-02T00:00:00Z'
};

const EXISTING_TOKEN_JOB: ApiBiddingJob = {
	jobId: 'job-token-42',
	status: 'enabled',
	revision: 1,
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z',
	archivedAt: null,
	target: {
		type: 'token',
		tokenId: '42'
	},
	config: {
		floorEth: '0.2',
		ceilingEth: '0.4',
		deltaEth: '0.01',
		pricingSource: null
	},
	runtime: null
};

describe('buildBiddingAutomationDraftFromBid', () => {
	it('creates a submittable token draft from a token-scoped bid', () => {
		const draft = buildBiddingAutomationDraftFromBid(
			{
				...BASE_BID,
				scope: {
					kind: 'token',
					label: '#42',
					tokenId: '42',
					traits: []
				}
			},
			EXISTING_TOKEN_JOB
		);

		expect(draft?.source.type).toBe(BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.SelectedBid);
		expect(draft?.target).toEqual({
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch,
			tokenIds: ['42']
		});
		expect(draft?.pricing).toEqual({
			mode: BIDDING_AUTOMATION_PRICING_MODE.Manual,
			floorEth: '0.303',
			ceilingEth: '0.303',
			deltaEth: '0.01'
		});
		expect(biddingAutomationDraftTokenId(draft)).toBe('42');
		expect(isBiddingAutomationDraftSubmittable(draft)).toBe(true);
	});

	it('creates a submittable trait draft without fanning out to token IDs', () => {
		const draft = buildBiddingAutomationDraftFromBid({
			...BASE_BID,
			scope: {
				kind: 'trait',
				label: 'Biome=42 + Mode=Terrain',
				tokenId: null,
				traits: [
					{ type: 'Biome', value: '42' },
					{ type: 'Mode', value: 'Terrain' }
				]
			}
		});

		expect(draft?.target).toEqual({
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob,
			traits: [
				{ key: 'Biome', value: '42' },
				{ key: 'Mode', value: 'Terrain' }
			],
			traitJoinMode: 'and'
		});
		expect(biddingAutomationDraftTokenId(draft)).toBe(null);
		expect(isBiddingAutomationDraftSubmittable(draft)).toBe(true);
	});

	it('creates a submittable collection draft', () => {
		const draft = buildBiddingAutomationDraftFromBid(BASE_BID);

		expect(draft?.target).toEqual({
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.CollectionJob
		});
		expect(isBiddingAutomationDraftSubmittable(draft)).toBe(true);
	});
});

describe('buildBiddingAutomationDraftFromSelection', () => {
	it('turns clean exact trait filters into a trait job draft', () => {
		const draft = buildBiddingAutomationDraftFromSelection({
			type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens,
			targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TraitJob,
			filter: {
				source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenBrowser,
				selectedTraits: [
					{ key: 'Biome', value: '42' },
					{ key: 'Mode', value: 'Terrain' }
				],
				selectedTraitRanges: [],
				traitJoinMode: 'and',
				tokenStatus: null,
				makerAddress: null
			},
			tokenCount: 12,
			state: {
				kind: BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean
			}
		});

		expect(draft?.target).toEqual({
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob,
			traits: [
				{ key: 'Biome', value: '42' },
				{ key: 'Mode', value: 'Terrain' }
			],
			traitJoinMode: 'and'
		});
		expect(isBiddingAutomationDraftSubmittable(draft)).toBe(true);
	});

	it('keeps visible token adjustments as an explicit token batch draft', () => {
		const draft = buildBiddingAutomationDraftFromSelection({
			type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens,
			targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TokenBatch,
			filter: {
				source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenBrowser,
				selectedTraits: [{ key: 'Biome', value: '42' }],
				selectedTraitRanges: [],
				traitJoinMode: 'and',
				tokenStatus: 'all',
				makerAddress: null
			},
			tokenCount: 12,
			state: {
				kind: BIDDING_AUTOMATION_FILTER_SELECTION_STATE.VisibleTokenAdjustments,
				visibleTokenIds: ['1', '2']
			}
		});

		expect(draft?.target).toEqual({
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch,
			tokenIds: ['1', '2']
		});
		expect(isBiddingAutomationDraftSubmittable(draft)).toBe(true);
	});
});
