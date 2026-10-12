import { describe, expect, it } from 'vitest';
import { bidBookCriteriaToBrowseFilters } from './bidding-bid-book-display';
import {
	COLLECTION_BIDDING_BID_SCOPE_FILTER,
	COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE
} from '@artgod/shared/types';
import { capturedOpenSeaRangedOfferFixtures } from '@artgod/shared/testing/opensea-offers';
import {
	biddingTraitScopeMatchesFilters,
	parseBiddingTraitCriteria
} from '@artgod/shared/trading/offer-trait-criteria';
import {
	buildCollectionBiddingQuery,
	parseCollectionBiddingTraitFilterJoinMode
} from './bidding-query';
import { parseSelectedTraits, parseSelectedTraitRanges } from './trait-filters';

describe('bid book criteria navigation', () => {
	it.each([
		{ type: 'Palette', value: 'Red,Blue' },
		{ type: 'Trait:Kind', value: 'Rare' },
		{ type: 'Trait,Kind', value: 'Rare' },
		{ type: 'Level,Height', min: 1, max: 2 },
		{ type: 'Level:Height', min: 1, max: 2 }
	])('omits navigation when accepted source text cannot round-trip: %j', (criterion) => {
		const scope = parseBiddingTraitCriteria([criterion, { type: 'Other Level', min: 1, max: 2 }]);
		expect(scope).toEqual([criterion, { type: 'Other Level', min: 1, max: 2 }]);
		expect(bidBookCriteriaToBrowseFilters(scope)).toBeNull();
		expect(bidBookCriteriaToBrowseFilters([...scope].reverse())).toBeNull();
	});
	it('round-trips safe punctuation without substituting a different trait bucket', () => {
		const scope = [
			{ type: 'Palette', value: 'Red:Blue' },
			{ type: 'Level & Édition/%+?#', min: 1, max: 2 }
		];
		const filters = bidBookCriteriaToBrowseFilters(scope)!;
		expect(filters).not.toBeNull();
		const query = buildCollectionBiddingQuery({
			bidScope: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
			selectedTraits: filters.traits,
			selectedTraitRanges: filters.traitRanges,
			traitJoinMode: filters.traitJoinMode
		});
		const decoded = new URLSearchParams(query.toString());
		const matching = [scope, [{ type: 'Palette:Red', value: 'Blue' }, scope[1]]].filter(
			(criteria) =>
				biddingTraitScopeMatchesFilters(
					criteria,
					parseSelectedTraits(decoded),
					parseSelectedTraitRanges(decoded),
					parseCollectionBiddingTraitFilterJoinMode(decoded)
				)
		);
		expect(matching).toEqual([scope]);
	});

	it('preserves exact values and both numeric bounds in the browse filter', () => {
		expect(
			bidBookCriteriaToBrowseFilters([
				{ type: 'Mode', value: 'Terrain' },
				{ type: 'Level', min: 1, max: 2 }
			])
		).toEqual({
			traits: [{ key: 'Mode', value: 'Terrain' }],
			traitRanges: [{ key: 'Level', fromValue: '1', toValue: '2' }],
			traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And
		});
	});
	it('round-trips the captured scope and excludes its disjoint range from demand', () => {
		const filters = bidBookCriteriaToBrowseFilters(
			capturedOpenSeaRangedOfferFixtures[0].expected.traits
		)!;
		const query = buildCollectionBiddingQuery({
			bidScope: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
			selectedTraits: filters.traits,
			selectedTraitRanges: filters.traitRanges,
			traitJoinMode: filters.traitJoinMode
		});
		const matching = capturedOpenSeaRangedOfferFixtures.filter(({ expected }) =>
			biddingTraitScopeMatchesFilters(
				expected.traits,
				parseSelectedTraits(query),
				parseSelectedTraitRanges(query),
				parseCollectionBiddingTraitFilterJoinMode(query)
			)
		);
		expect(matching.map(({ expected }) => expected.label)).toEqual([
			capturedOpenSeaRangedOfferFixtures[0].expected.label
		]);
	});
	it('uses AND for numeric-only conjunctions and retains exact-trait discovery behavior', () => {
		const criteria = [
			{ type: 'Level', min: 1, max: 2 },
			{ type: 'Height', min: 5, max: 6 }
		];
		const filters = bidBookCriteriaToBrowseFilters(criteria)!;
		expect(filters.traitJoinMode).toBe(COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And);
		expect(
			biddingTraitScopeMatchesFilters(
				[{ type: 'Level', min: 19, max: 20 }, criteria[1]],
				filters.traits,
				filters.traitRanges,
				filters.traitJoinMode
			)
		).toBe(false);
		expect(
			bidBookCriteriaToBrowseFilters([{ type: 'Mode', value: 'Terrain' }])?.traitJoinMode
		).toBe(COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.Or);
	});
	it('deduplicates identical criteria before the query round trip', () => {
		const criterion = { type: 'Level', min: 1, max: 2 };
		const filters = bidBookCriteriaToBrowseFilters([criterion, criterion])!;
		const query = buildCollectionBiddingQuery({
			bidScope: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
			selectedTraits: filters.traits,
			selectedTraitRanges: filters.traitRanges,
			traitJoinMode: filters.traitJoinMode
		});
		expect(parseSelectedTraitRanges(query)).toEqual([
			{ key: 'Level', fromValue: '1', toValue: '2' }
		]);
	});
	it('omits navigation for distinct same-key conjunctions in either order', () => {
		for (const criteria of [
			[
				{ type: 'Level', min: 1, max: 10 },
				{ type: 'Level', min: 2, max: 3 }
			],
			[
				{ type: 'Level', min: 1, max: 5 },
				{ type: 'Level', min: 4, max: 10 }
			],
			[
				{ type: 'Level', min: 1, max: 2 },
				{ type: 'Level', min: 19, max: 20 }
			],
			[
				{ type: 'Level', min: 1, max: 10 },
				{ type: 'Level', value: '2' }
			],
			[
				{ type: 'Mode', value: 'Terrain' },
				{ type: 'Mode', value: 'Daydream' },
				{ type: 'Level', min: 1, max: 2 }
			]
		]) {
			expect(bidBookCriteriaToBrowseFilters(criteria)).toBeNull();
			expect(bidBookCriteriaToBrowseFilters([...criteria].reverse())).toBeNull();
		}
	});
	it('omits navigation when existing browse ranges cannot represent the whole scope', () => {
		for (const min of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(
				bidBookCriteriaToBrowseFilters([
					{ type: 'Mode', value: 'Terrain' },
					{ type: 'Level', min, max: min + 2 }
				])
			).toBeNull();
		}
	});
});
