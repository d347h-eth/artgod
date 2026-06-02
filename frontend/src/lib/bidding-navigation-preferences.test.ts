import { describe, expect, it } from 'vitest';
import { applyCollectionBiddingNavigationPreferenceToQuery } from '$lib/bidding-navigation-preferences';

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
				new URLSearchParams('bid_scope=collection'),
				{
					bidScope: 'traits'
				}
			).toString()
		).toBe('bid_scope=collection');
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

});
