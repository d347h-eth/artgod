import { describe, expect, it } from 'vitest';
import {
	applyCollectionBiddingNavigationPreferenceToQuery,
	preferredCollectionBiddingHref
} from '$lib/bidding-navigation-preferences';

describe('applyCollectionBiddingNavigationPreferenceToQuery', () => {
	it('adds stored bidding navigation values when URL omits them', () => {
		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(
				'/ethereum/terraforms',
				new URLSearchParams('traits=Mode%3ATerrain'),
				{
					biddingView: 'bid_book',
					bidScope: 'traits'
				}
			).toString()
		).toBe('traits=Mode%3ATerrain&bid_scope=traits');

		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(
				'/ethereum/terraforms',
				new URLSearchParams(),
				{
					biddingView: 'jobs',
					bidScope: 'traits'
				}
			).toString()
		).toBe('bidding_view=jobs&bid_scope=traits');
	});

	it('keeps explicit URL values ahead of stored values', () => {
		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(
				'/ethereum/terraforms',
				new URLSearchParams('bidding_view=bid_book&bid_scope=collection'),
				{
					biddingView: 'jobs',
					bidScope: 'traits'
				}
			).toString()
		).toBe('bidding_view=bid_book&bid_scope=collection');
	});

	it('omits stored default values from the generated URL', () => {
		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(
				'/ethereum/terraforms',
				new URLSearchParams(),
				{
					biddingView: 'bid_book',
					bidScope: 'collection'
				}
			).toString()
		).toBe('');
	});
});

describe('preferredCollectionBiddingHref', () => {
	it('formats a structured collection bidding href from base path and query', () => {
		expect(
			preferredCollectionBiddingHref({
				basePath: '/ethereum/terraforms',
				query: new URLSearchParams('traits=Mode%3ATerrain')
			})
		).toBe('/ethereum/terraforms/bidding?traits=Mode%3ATerrain');
	});
});
