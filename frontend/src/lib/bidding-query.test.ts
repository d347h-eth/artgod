import { describe, expect, it } from 'vitest';
import {
	COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS,
	COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER,
	COLLECTION_BIDDING_BID_SCOPE_FILTER,
	TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT
} from '@artgod/shared/types';
import {
	COLLECTION_MEDIA_MODES,
	COLLECTION_MEDIA_PREFERENCE_VALUES,
	COLLECTION_MEDIA_QUERY_PARAMS
} from '@artgod/shared/extensions';
import {
	buildCollectionBiddingQuery,
	parseBidBookMakerFilter,
	parseBidBookOwnershipFilter,
	parseBidBookOwnStateFilter,
	nextCollectionBiddingBidScopeFilter,
	parseCollectionBiddingBidScopeFilter,
	parseCollectionBiddingTraitFilterJoinMode
} from '$lib/bidding-query';

describe('buildCollectionBiddingQuery', () => {
	it.each([
		COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active,
		TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT.Ceiling
	])('preserves %s across trait and token scopes and clears it for collection scope', (state) => {
		expect(
			parseBidBookOwnStateFilter(
				new URLSearchParams({ [COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState]: ` ${state} ` })
			)
		).toBe(state);
		for (const bidScope of Object.values(COLLECTION_BIDDING_BID_SCOPE_FILTER)) {
			const query = buildCollectionBiddingQuery({
				selectedTraits: [],
				selectedTraitRanges: [],
				bidScope,
				ownStateFilter: state
			});
			expect(parseBidBookOwnStateFilter(query)).toBe(
				bidScope === COLLECTION_BIDDING_BID_SCOPE_FILTER.Collection ? null : state
			);
		}
		expect(
			parseBidBookOwnStateFilter(
				new URLSearchParams({ [COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.OwnState]: 'unsupported' })
			)
		).toBeNull();
	});
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

	it('uses semantic own ownership instead of a maker address', () => {
		const query = buildCollectionBiddingQuery({
			selectedTraits: [],
			selectedTraitRanges: [],
			bidScope: 'collection',
			maker: '0x1111111111111111111111111111111111111111',
			ownershipFilter: 'own'
		});

		expect(query.get('ownership')).toBe('own');
		expect(query.get('maker')).toBeNull();
		expect(parseBidBookOwnershipFilter(query)).toBe('own');
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
