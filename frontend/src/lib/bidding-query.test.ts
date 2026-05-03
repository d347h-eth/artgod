import { describe, expect, it } from 'vitest';
import {
	buildCollectionBiddingQuery,
	parseCollectionBiddingTraitFilterJoinMode
} from '$lib/bidding-query';

describe('buildCollectionBiddingQuery', () => {
	it('omits default OR trait join mode and preserves non-default AND mode', () => {
		const defaultQuery = buildCollectionBiddingQuery({
			selectedTraits: [],
			selectedTraitRanges: [],
			bidScope: 'traits',
			traitJoinMode: 'or'
		});
		expect(defaultQuery.get('trait_join')).toBeNull();

		const strictQuery = buildCollectionBiddingQuery({
			selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
			selectedTraitRanges: [],
			bidScope: 'traits',
			traitJoinMode: 'and'
		});
		expect(strictQuery.get('trait_join')).toBe('and');
		expect(strictQuery.getAll('traits')).toEqual(['Mode:Terrain']);
	});
});

describe('parseCollectionBiddingTraitFilterJoinMode', () => {
	it('parses AND mode and defaults everything else to OR', () => {
		expect(
			parseCollectionBiddingTraitFilterJoinMode(new URLSearchParams('trait_join=and'))
		).toBe('and');
		expect(
			parseCollectionBiddingTraitFilterJoinMode(new URLSearchParams('trait_join=or'))
		).toBe('or');
		expect(
			parseCollectionBiddingTraitFilterJoinMode(new URLSearchParams('trait_join=nope'))
		).toBe('or');
	});
});
