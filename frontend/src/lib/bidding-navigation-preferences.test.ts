import { describe, expect, it } from 'vitest';
import {
	applyCollectionBiddingNavigationPreferenceToQuery,
	type CollectionBiddingNavigationPreference
} from '$lib/bidding-navigation-preferences';

describe('applyCollectionBiddingNavigationPreferenceToQuery', () => {
	it('adds stored bid scope when URL omits it', () => {
		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(
				new URLSearchParams('traits=Mode%3ATerrain'),
				{
					bidScope: 'traits'
				}
			).toString()
		).toBe('traits=Mode%3ATerrain&bid_scope=traits');

		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(
				new URLSearchParams(),
				{
					bidScope: 'traits'
				}
			).toString()
		).toBe('bid_scope=traits');
	});

	it('keeps explicit URL bid scope ahead of stored values', () => {
		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(
				new URLSearchParams('bidding_view=bid_book&bid_scope=collection'),
				{
					bidScope: 'traits'
				}
			).toString()
		).toBe('bidding_view=bid_book&bid_scope=collection');
	});

	it('omits stored default values from the generated URL', () => {
		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(
				new URLSearchParams(),
				{
					bidScope: 'token'
				}
			).toString()
		).toBe('');
	});

	it('persists non-default collection scope explicitly', () => {
		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(
				new URLSearchParams(),
				{
					bidScope: 'collection'
				}
			).toString()
		).toBe('bid_scope=collection');
	});

	it('ignores obsolete stored bidding view values', () => {
		const obsoletePreference = JSON.parse(
			'{"biddingView":"jobs","bidScope":"traits"}'
		) as Partial<CollectionBiddingNavigationPreference>;

		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(
				new URLSearchParams(),
				obsoletePreference
			).toString()
		).toBe('bid_scope=traits');
	});
});
