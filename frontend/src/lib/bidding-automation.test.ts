import { describe, expect, it } from 'vitest';
import type { ApiBiddingBidBookRow, ApiBiddingJob } from '$lib/api-types';
import {
	BIDDING_AUTOMATION_DRAFT_TARGET_TYPE,
	BIDDING_AUTOMATION_FILTER_SELECTION_STATE,
	BIDDING_AUTOMATION_FILTER_TARGET_INTENT,
	BIDDING_AUTOMATION_PRICING_MODE,
	BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE,
	BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE,
	bestBiddingAutomationBid,
	biddingAutomationDraftTokenId,
	biddingTraitCriteriaToTokenAttributes,
	buildBiddingAutomationTokenFilterSnapshot,
	buildBiddingJobTargetLookupRequestBody,
	buildBiddingAutomationDraftFromBid,
	buildBiddingAutomationDraftFromSelection,
	buildTokenBiddingAutomationDraftFromBid,
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
	seenAt: '2026-01-02T00:00:00Z',
	ownStatus: null
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
			floorEth: '0.301',
			ceilingEth: '0.301',
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

	it('uses price-magnitude steps for default bid deltas', () => {
		const cases = [
			{ priceWei: '4000000000000000000', priceEth: '4', deltaEth: '0.01', nextEth: '4.01' },
			{ priceWei: '20000000000000000000', priceEth: '20', deltaEth: '0.1', nextEth: '20.1' },
			{ priceWei: '230000000000000000', priceEth: '0.23', deltaEth: '0.001', nextEth: '0.231' },
			{ priceWei: '50000000000000000', priceEth: '0.05', deltaEth: '0.0001', nextEth: '0.0501' }
		];

		for (const item of cases) {
			const draft = buildBiddingAutomationDraftFromBid({
				...BASE_BID,
				priceWei: item.priceWei,
				priceEth: item.priceEth
			});
			expect(draft?.pricing).toMatchObject({
				mode: BIDDING_AUTOMATION_PRICING_MODE.Manual,
				floorEth: item.nextEth,
				ceilingEth: item.nextEth,
				deltaEth: item.deltaEth
			});
		}
	});
});

describe('buildTokenBiddingAutomationDraftFromBid', () => {
	it('uses the selected bid price but keeps the token detail target token-scoped', () => {
		const draft = buildTokenBiddingAutomationDraftFromBid(
			{
				...BASE_BID,
				scope: {
					kind: 'trait',
					label: 'Hat=Beanie',
					tokenId: null,
					traits: [{ type: 'Hat', value: 'Beanie' }]
				}
			},
			'42'
		);

		expect(draft?.target).toEqual({
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TokenBatch,
			tokenIds: ['42']
		});
		expect(draft?.pricing).toEqual({
			mode: BIDDING_AUTOMATION_PRICING_MODE.Manual,
			floorEth: '0.301',
			ceilingEth: '0.301',
			deltaEth: '0.001'
		});
		expect(biddingAutomationDraftTokenId(draft)).toBe('42');
	});
});

describe('bestBiddingAutomationBid', () => {
	it('selects the highest bid for draft pricing', () => {
		const lower = { ...BASE_BID, orderId: '0xlower', priceWei: '100000000000000000' };
		const higher = { ...BASE_BID, orderId: '0xhigher', priceWei: '200000000000000000' };

		expect(bestBiddingAutomationBid([lower, higher])?.orderId).toBe('0xhigher');
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

	it('projects OR-filtered exact traits into one AND trait job target when explicitly requested', () => {
		const draft = buildBiddingAutomationDraftFromSelection({
			type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens,
			targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TraitJob,
			filter: {
				source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenOffers,
				selectedTraits: [
					{ key: 'Biome', value: '42' },
					{ key: 'Mode', value: 'Terrain' }
				],
				selectedTraitRanges: [],
				traitJoinMode: 'or',
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

describe('buildBiddingJobTargetLookupRequestBody', () => {
	it('maps single token, trait, and collection drafts to backend lookup targets', () => {
		const tokenDraft = buildBiddingAutomationDraftFromBid({
			...BASE_BID,
			scope: {
				kind: 'token',
				label: '#42',
				tokenId: '42',
				traits: []
			}
		});
		expect(buildBiddingJobTargetLookupRequestBody(tokenDraft)).toEqual({
			target: {
				type: 'token',
				tokenId: '42'
			}
		});

		const traitDraft = buildBiddingAutomationDraftFromBid({
			...BASE_BID,
			quantity: '2',
			scope: {
				kind: 'trait',
				label: 'Biome=42',
				tokenId: null,
				traits: [{ type: 'Biome', value: '42' }]
			}
		});
		expect(buildBiddingJobTargetLookupRequestBody(traitDraft)).toEqual({
			target: {
				type: 'trait',
				quantity: 2,
				targetTraits: [{ type: 'Biome', value: '42' }]
			}
		});

		const collectionDraft = buildBiddingAutomationDraftFromBid({
			...BASE_BID,
			quantity: '3'
		});
		expect(buildBiddingJobTargetLookupRequestBody(collectionDraft)).toEqual({
			target: {
				type: 'collection',
				quantity: 3
			}
		});
	});

	it('does not build one lookup for multi-token or broad filtered batch drafts', () => {
		const multiTokenDraft = buildBiddingAutomationDraftFromSelection({
			type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.ExplicitTokens,
			tokenIds: ['1', '2']
		});
		expect(buildBiddingJobTargetLookupRequestBody(multiTokenDraft)).toBeNull();

		const filteredDraft = buildBiddingAutomationDraftFromSelection({
			type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens,
			targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TokenBatch,
			filter: {
				source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenOffers,
				selectedTraits: [],
				selectedTraitRanges: [],
				traitJoinMode: 'or',
				tokenStatus: null,
				makerAddress: null
			},
			tokenCount: 12,
			state: {
				kind: BIDDING_AUTOMATION_FILTER_SELECTION_STATE.Clean
			}
		});
		expect(buildBiddingJobTargetLookupRequestBody(filteredDraft)).toBeNull();
	});
});

describe('biddingTraitCriteriaToTokenAttributes', () => {
	it('maps bid-book trait criteria into reusable trait-filter attributes', () => {
		expect(
			biddingTraitCriteriaToTokenAttributes([
				{ type: 'Biome', value: '42' },
				{ type: 'Mode', value: 'Terrain' }
			])
		).toEqual([
			{ key: 'Biome', value: '42' },
			{ key: 'Mode', value: 'Terrain' }
		]);
	});
});

describe('buildBiddingAutomationTokenFilterSnapshot', () => {
	it('normalizes optional filter values used by bidding controls', () => {
		expect(
			buildBiddingAutomationTokenFilterSnapshot({
				source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenOffers,
				selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
				selectedTraitRanges: [],
				traitJoinMode: 'or'
			})
		).toEqual({
			source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenOffers,
			selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
			selectedTraitRanges: [],
			traitJoinMode: 'or',
			tokenStatus: null,
			makerAddress: null
		});
	});
});
