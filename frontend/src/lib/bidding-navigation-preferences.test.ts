import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER as STATE,
	COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER as OWNERSHIP,
	COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS as PARAM,
	COLLECTION_BIDDING_BID_SCOPE_FILTER as SCOPE,
	TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE as PHASE
} from '@artgod/shared/types';
import {
	applyCollectionBiddingNavigationPreferenceToQuery,
	buildCollectionBiddingNavigationQuery
} from '$lib/bidding-navigation-preferences';

const deployment = vi.hoisted(() => ({ isPublic: false }));
vi.mock('$lib/runtime/public-deployment', () => ({
	get IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT() {
		return deployment.isPublic;
	}
}));
afterEach(() => {
	deployment.isPublic = false;
});

const FILTERS = { selectedTraits: [], selectedTraitRanges: [] };

describe('buildCollectionBiddingNavigationQuery', () => {
	it('defaults fresh private Offers navigation to My bids and Active', () => {
		const query = buildCollectionBiddingNavigationQuery(FILTERS, null);
		expect(query.get(PARAM.Ownership)).toBe(OWNERSHIP.Own);
		expect(query.get(PARAM.OwnState)).toBe(STATE.Active);
	});

	it('keeps legacy remembered scope and supplies the new private defaults', () => {
		const query = buildCollectionBiddingNavigationQuery(FILTERS, { bidScope: SCOPE.Traits });
		expect(query.get(PARAM.BidScope)).toBe(SCOPE.Traits);
		expect(query.get(PARAM.Ownership)).toBe(OWNERSHIP.Own);
		expect(query.get(PARAM.OwnState)).toBe(STATE.Active);
	});

	it('restores remembered ownership and status independently, including cleared choices', () => {
		const paused = buildCollectionBiddingNavigationQuery(FILTERS, {
			bidScope: SCOPE.Traits,
			ownershipFilter: null,
			ownStateFilter: PHASE.Paused
		});
		expect(paused.get(PARAM.BidScope)).toBe(SCOPE.Traits);
		expect(paused.has(PARAM.Ownership)).toBe(false);
		expect(paused.get(PARAM.OwnState)).toBe(PHASE.Paused);
		const reset = buildCollectionBiddingNavigationQuery(FILTERS, {
			bidScope: SCOPE.Token,
			ownershipFilter: OWNERSHIP.Own,
			ownStateFilter: null
		});
		expect(reset.get(PARAM.Ownership)).toBe(OWNERSHIP.Own);
		expect(reset.has(PARAM.OwnState)).toBe(false);
	});

	it('keeps explicit current choices ahead of preferences, including All bids and reset', () => {
		const query = buildCollectionBiddingNavigationQuery(
			{
				...FILTERS,
				bidScope: SCOPE.Token,
				ownershipFilter: null,
				ownStateFilter: null
			},
			{
				bidScope: SCOPE.Traits,
				ownershipFilter: OWNERSHIP.Own,
				ownStateFilter: PHASE.Paused
			}
		);
		expect(query.has(PARAM.BidScope)).toBe(false);
		expect(query.has(PARAM.Ownership)).toBe(false);
		expect(query.has(PARAM.OwnState)).toBe(false);
	});

	it('never applies private ownership/status defaults or choices to public Offers navigation', () => {
		deployment.isPublic = true;
		const fresh = buildCollectionBiddingNavigationQuery(FILTERS, null);
		expect(fresh.has(PARAM.Ownership)).toBe(false);
		expect(fresh.has(PARAM.OwnState)).toBe(false);
		const query = buildCollectionBiddingNavigationQuery(
			{
				...FILTERS,
				selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
				ownershipFilter: OWNERSHIP.Own,
				ownStateFilter: STATE.Active
			},
			{
				bidScope: SCOPE.Traits,
				ownershipFilter: OWNERSHIP.Own,
				ownStateFilter: PHASE.Paused
			}
		);
		expect(query.get(PARAM.BidScope)).toBe(SCOPE.Traits);
		expect(query.has(PARAM.Ownership)).toBe(false);
		expect(query.has(PARAM.OwnState)).toBe(false);
		expect(query.get('traits')).toBe('Mode:Terrain');
	});
});

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
			applyCollectionBiddingNavigationPreferenceToQuery(new URLSearchParams(), {
				bidScope: 'traits'
			}).toString()
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
			applyCollectionBiddingNavigationPreferenceToQuery(new URLSearchParams(), {
				bidScope: 'token'
			}).toString()
		).toBe('');
	});

	it('persists non-default collection scope explicitly', () => {
		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(new URLSearchParams(), {
				bidScope: 'collection'
			}).toString()
		).toBe('bid_scope=collection');
	});
	it('restores scope without reapplying ownership or state to a reset URL', () => {
		const query = applyCollectionBiddingNavigationPreferenceToQuery(new URLSearchParams(), {
			bidScope: SCOPE.Traits,
			ownershipFilter: OWNERSHIP.Own,
			ownStateFilter: STATE.Active
		});
		expect(query.get(PARAM.BidScope)).toBe(SCOPE.Traits);
		expect(query.has(PARAM.Ownership)).toBe(false);
		expect(query.has(PARAM.OwnState)).toBe(false);
	});
});
