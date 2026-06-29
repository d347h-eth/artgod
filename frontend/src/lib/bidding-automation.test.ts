import { describe, expect, it } from 'vitest';
import { TRADING_BIDDING_BID_SCOPE_KIND } from '@artgod/shared/types';
import {
	TERRAFORMS_MODE_ATTRIBUTE_KEY,
	TERRAFORMS_MODE_ATTRIBUTE_VALUES,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
	TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES
} from '@artgod/shared/extensions/terraforms';
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
	isBiddingAutomationDraftSubmittable,
	withMarketplaceBiddingTraitSupport
} from '$lib/bidding-automation';

const BASE_BID: ApiBiddingBidBookRow = {
	orderId: '0xbase',
	source: 'orders',
	materialization: {
		kind: 'market_bid',
		jobId: null,
		status: null,
		phase: null
	},
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
	price: exactPrice('300000000000000000', '0.3'),
	bidLimits: null,
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

function exactPrice(wei: string, eth: string): ApiBiddingBidBookRow['price'] {
	return {
		kind: 'exact',
		wei,
		eth
	};
}

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
			floorEth: '0.2',
			ceilingEth: '0.4',
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
			{ wei: '4000000000000000000', eth: '4', deltaEth: '0.01', nextEth: '4.01' },
			{ wei: '20000000000000000000', eth: '20', deltaEth: '0.1', nextEth: '20.1' },
			{ wei: '230000000000000000', eth: '0.23', deltaEth: '0.001', nextEth: '0.231' },
			{ wei: '50000000000000000', eth: '0.05', deltaEth: '0.0001', nextEth: '0.0501' }
		];

		for (const item of cases) {
			const draft = buildBiddingAutomationDraftFromBid({
				...BASE_BID,
				price: exactPrice(item.wei, item.eth)
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
		const lower = {
			...BASE_BID,
			orderId: '0xlower',
			price: exactPrice('100000000000000000', '0.1')
		};
		const higher = {
			...BASE_BID,
			orderId: '0xhigher',
			price: exactPrice('200000000000000000', '0.2')
		};

		expect(bestBiddingAutomationBid([lower, higher])?.orderId).toBe('0xhigher');
	});
});

describe('buildBiddingAutomationDraftFromSelection', () => {
	it('uses selected bid selections as bid-priced drafts', () => {
		const draft = buildBiddingAutomationDraftFromSelection({
			type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.SelectedBid,
			bid: {
				...BASE_BID,
				scope: {
					kind: TRADING_BIDDING_BID_SCOPE_KIND.Trait,
					label: 'Biome=42',
					tokenId: null,
					traits: [{ type: 'Biome', value: '42' }]
				}
			}
		});

		expect(draft?.target).toEqual({
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.TraitJob,
			traits: [{ key: 'Biome', value: '42' }],
			traitJoinMode: 'and'
		});
		expect(draft?.pricing).toEqual({
			mode: BIDDING_AUTOMATION_PRICING_MODE.Manual,
			floorEth: '0.301',
			ceilingEth: '0.301',
			deltaEth: '0.001'
		});
	});

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

	it('blocks direct trait job drafts when every selected trait is unsupported by marketplace bidding', () => {
		const draft = buildBiddingAutomationDraftFromSelection({
			type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens,
			targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TraitJob,
			filter: {
				source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenBrowser,
				selectedTraits: [
					{
						key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
						value: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
						marketplaceBiddingSupported: false
					}
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
			type: BIDDING_AUTOMATION_DRAFT_TARGET_TYPE.UnsupportedTraitJob,
			traits: [
				{
					key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
					value: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
					marketplaceBiddingSupported: false
				}
			],
			traitJoinMode: 'and'
		});
		expect(isBiddingAutomationDraftSubmittable(draft)).toBe(false);
		expect(buildBiddingJobTargetLookupRequestBody(draft)).toBeNull();
	});

	it('silently drops unsupported traits from mixed direct trait job drafts', () => {
		const draft = buildBiddingAutomationDraftFromSelection({
			type: BIDDING_AUTOMATION_SELECTION_SOURCE_TYPE.FilteredTokens,
			targetIntent: BIDDING_AUTOMATION_FILTER_TARGET_INTENT.TraitJob,
			filter: {
				source: BIDDING_AUTOMATION_TOKEN_FILTER_SOURCE.TokenBrowser,
				selectedTraits: [
					{
						key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
						value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
						marketplaceBiddingSupported: true
					},
					{
						key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
						value: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
						marketplaceBiddingSupported: false
					}
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
				{
					key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
					value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain
				}
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

describe('withMarketplaceBiddingTraitSupport', () => {
	it('attaches support flags from trait facets to selected filters', () => {
		expect(
			withMarketplaceBiddingTraitSupport({
				selectedTraits: [
					{
						key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
						value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain
					},
					{
						key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
						value: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed
					}
				],
				facets: [
					{
						key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
						displayKind: 'set',
						minValue: null,
						maxValue: null,
						values: [
							{
								value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
								tokenCount: 1,
								marketplaceBiddingSupported: true
							}
						]
					},
					{
						key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
						displayKind: 'set',
						minValue: null,
						maxValue: null,
						values: [
							{
								value: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
								tokenCount: 1,
								marketplaceBiddingSupported: false
							}
						]
					}
				]
			})
		).toEqual([
			{
				key: TERRAFORMS_MODE_ATTRIBUTE_KEY,
				value: TERRAFORMS_MODE_ATTRIBUTE_VALUES.Terrain,
				marketplaceBiddingSupported: true
			},
			{
				key: TERRAFORMS_SEED_CLASS_ATTRIBUTE_KEY,
				value: TERRAFORMS_SEED_CLASS_ATTRIBUTE_VALUES.XSeed,
				marketplaceBiddingSupported: false
			}
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
