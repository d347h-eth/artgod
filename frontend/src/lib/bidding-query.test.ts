import { describe, expect, it } from 'vitest';
import {
	COLLECTION_MEDIA_MODES,
	COLLECTION_MEDIA_PREFERENCE_VALUES,
	COLLECTION_MEDIA_QUERY_PARAMS
} from '@artgod/shared/extensions';
import {
	buildCollectionBiddingQuery,
	parseBidBookMakerFilter,
	nextCollectionBiddingBidScopeFilter,
	parseCollectionBiddingBidScopeFilter,
	parseCollectionBiddingTraitFilterJoinMode
} from '$lib/bidding-query';

describe('buildCollectionBiddingQuery', () => {
	it('omits default token bid scope', () => {
		const query = buildCollectionBiddingQuery({
			selectedTraits: [],
			selectedTraitRanges: [],
			bidScope: 'token'
		});
		expect(query.get('bid_scope')).toBeNull();
	});

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

	it('preserves a maker address filter when present', () => {
		const query = buildCollectionBiddingQuery({
			selectedTraits: [],
			selectedTraitRanges: [],
			bidScope: 'collection',
			maker: ' 0x1111111111111111111111111111111111111111 '
		});
		expect(query.get('maker')).toBe('0x1111111111111111111111111111111111111111');
		expect(parseBidBookMakerFilter(query)).toBe('0x1111111111111111111111111111111111111111');
	});

	it('preserves an explicitly disabled media preference', () => {
		const query = buildCollectionBiddingQuery({
			selectedTraits: [],
			selectedTraitRanges: [],
			mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			mediaPreference: {
				label: 'prefer modern media',
				enabled: false,
				defaultEnabled: true
			}
		});

		expect(query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaPreference)).toBe(
			COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
		);
	});
});

describe('collection bidding ordered query controls', () => {
	it('parses bid scope from the canonical ordered value list', () => {
		expect(parseCollectionBiddingBidScopeFilter(new URLSearchParams('bid_scope=traits'))).toBe(
			'traits'
		);
		expect(parseCollectionBiddingBidScopeFilter(new URLSearchParams('bid_scope=nope'))).toBe(
			'token'
		);
	});

	it('cycles bid scope using the canonical ordered value list', () => {
		expect(nextCollectionBiddingBidScopeFilter('token')).toBe('traits');
		expect(nextCollectionBiddingBidScopeFilter('traits')).toBe('collection');
		expect(nextCollectionBiddingBidScopeFilter('collection')).toBe('token');
	});
});

describe('parseCollectionBiddingTraitFilterJoinMode', () => {
	it('parses AND mode and defaults everything else to OR', () => {
		expect(parseCollectionBiddingTraitFilterJoinMode(new URLSearchParams('trait_join=and'))).toBe(
			'and'
		);
		expect(parseCollectionBiddingTraitFilterJoinMode(new URLSearchParams('trait_join=or'))).toBe(
			'or'
		);
		expect(parseCollectionBiddingTraitFilterJoinMode(new URLSearchParams('trait_join=nope'))).toBe(
			'or'
		);
	});
});
