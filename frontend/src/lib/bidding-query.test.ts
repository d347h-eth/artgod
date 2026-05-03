import { describe, expect, it } from 'vitest';
import {
	buildCollectionBiddingQuery,
	nextCollectionBiddingBidScopeFilter,
	nextCollectionBiddingViewMode,
	parseCollectionBiddingBidScopeFilter,
	parseCollectionBiddingView,
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

describe('collection bidding ordered query controls', () => {
	it('parses bid scope and view from the canonical ordered value lists', () => {
		expect(parseCollectionBiddingBidScopeFilter(new URLSearchParams('bid_scope=traits'))).toBe(
			'traits'
		);
		expect(parseCollectionBiddingBidScopeFilter(new URLSearchParams('bid_scope=nope'))).toBe(
			'collection'
		);
		expect(parseCollectionBiddingView(new URLSearchParams('bidding_view=jobs'))).toBe('jobs');
		expect(parseCollectionBiddingView(new URLSearchParams('bidding_view=nope'))).toBe('bid_book');
	});

	it('cycles bid scope and view using their canonical ordered value lists', () => {
		expect(nextCollectionBiddingBidScopeFilter('collection')).toBe('traits');
		expect(nextCollectionBiddingBidScopeFilter('traits')).toBe('collection');
		expect(nextCollectionBiddingViewMode('bid_book')).toBe('jobs');
		expect(nextCollectionBiddingViewMode('jobs')).toBe('bid_book');
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
