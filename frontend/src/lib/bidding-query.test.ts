import { describe, expect, it } from 'vitest';
import {
	COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS,
	COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER,
	COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER,
	COLLECTION_BIDDING_BID_SCOPE_FILTER,
	COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE,
	TRADING_BIDDING_JOB_RUNTIME_CONSTRAINT
} from '@artgod/shared/types';
import {
	COLLECTION_MEDIA_MODES,
	COLLECTION_MEDIA_PREFERENCE_VALUES,
	COLLECTION_MEDIA_QUERY_PARAMS
} from '@artgod/shared/extensions';
import {
	buildCollectionBiddingQuery,
	buildCollectionBiddingHref,
	buildCollectionBiddingViewQuery,
	type CollectionBiddingQueryParams,
	parseBidBookMakerFilter,
	parseBidBookOwnershipFilter,
	parseBidBookOwnStateFilter,
	nextCollectionBiddingBidScopeFilter,
	parseCollectionBiddingBidScopeFilter,
	parseCollectionBiddingTraitFilterJoinMode
} from '$lib/bidding-query';

describe('buildCollectionBiddingQuery', () => {
	it('preserves every unchanged filter and leaves the current query untouched', () => {
		const current: CollectionBiddingQueryParams = {
			selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
			selectedTraitRanges: [{ key: 'Height', fromValue: '3', toValue: '9' }],
			bidScope: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
			traitJoinMode: COLLECTION_BIDDING_TRAIT_FILTER_JOIN_MODE.And,
			mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
			mediaPreference: { label: 'prefer modern media', enabled: false, defaultEnabled: true },
			maker: '0x1111111111111111111111111111111111111111',
			ownStateFilter: COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active,
			showMuted: true
		};
		const original = buildCollectionBiddingQuery(current).toString();
		const page = buildCollectionBiddingQuery(current, { limit: 5, cursor: 'next-page' });
		page.delete('limit');
		page.delete('cursor');
		expect(page.toString()).toBe(original);
		expect(buildCollectionBiddingQuery(current).toString()).toBe(original);
	});

	it('clears only explicitly overridden controls while preserving independent filters', () => {
		const current: CollectionBiddingQueryParams = {
			selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
			selectedTraitRanges: [],
			ownershipFilter: COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER.Own,
			ownStateFilter: COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active,
			showMuted: true,
			cursor: 'previous-page'
		};
		const query = buildCollectionBiddingQuery(current, {
			ownershipFilter: null,
			maker: '0x1111111111111111111111111111111111111111',
			selectedTraits: [],
			cursor: null
		});
		expect(parseBidBookOwnershipFilter(query)).toBeNull();
		expect(parseBidBookMakerFilter(query)).toBe('0x1111111111111111111111111111111111111111');
		expect(parseBidBookOwnStateFilter(query)).toBe(current.ownStateFilter);
		expect(query.getAll('traits')).toEqual([]);
		expect(query.has('cursor')).toBe(false);
		expect(query.get(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.ShowMuted)).toBe('true');
		const reset = buildCollectionBiddingQuery(current, { ownStateFilter: null });
		expect(parseBidBookOwnStateFilter(reset)).toBeNull();
		expect(parseBidBookOwnershipFilter(reset)).toBe(current.ownershipFilter);
	});

	it('preserves own state for the implicit default token scope', () => {
		const query = buildCollectionBiddingQuery({
			selectedTraits: [],
			selectedTraitRanges: [],
			ownStateFilter: COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active
		});
		expect(parseBidBookOwnStateFilter(query)).toBe(
			COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active
		);
	});

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

describe('bidding view queries', () => {
	it('keeps the requested scope explicit on links and return queries', () => {
		const current = {
			selectedTraits: [],
			selectedTraitRanges: [],
			bidScope: COLLECTION_BIDDING_BID_SCOPE_FILTER.Traits,
			ownStateFilter: COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER.Active
		};
		const overrides = { bidScope: COLLECTION_BIDDING_BID_SCOPE_FILTER.Token };
		const query = buildCollectionBiddingViewQuery(current, overrides);
		expect(query.get(COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS.BidScope)).toBe(overrides.bidScope);
		expect(parseBidBookOwnStateFilter(query)).toBe(current.ownStateFilter);
		expect(buildCollectionBiddingHref({ ...current, basePath: '/collection' }, overrides)).toBe(
			`/collection/bidding?${query}`
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
