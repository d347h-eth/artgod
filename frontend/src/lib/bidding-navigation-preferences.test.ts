import { afterEach, describe, expect, it, vi } from 'vitest';
import { COLLECTION_MEDIA_MODES, COLLECTION_MEDIA_QUERY_PARAMS } from '@artgod/shared/extensions';
import {
	COLLECTION_BIDDING_BID_BOOK_OWN_STATE_FILTER as STATE,
	COLLECTION_BIDDING_BID_BOOK_OWNERSHIP_FILTER as OWNERSHIP,
	COLLECTION_BIDDING_BID_BOOK_QUERY_PARAMS as PARAM,
	COLLECTION_BIDDING_BID_SCOPE_FILTER as SCOPE,
	TRADING_BIDDING_BID_BOOK_OWN_JOB_PHASE as PHASE,
	TRADING_BIDDING_JOB_RUNTIME_BID_POSITION as POSITION
} from '@artgod/shared/types';
import {
	applyCollectionBiddingNavigationPreferenceToQuery,
	buildCollectionBiddingNavigationQuery,
	buildCollectionBiddingScopeHref,
	readCollectionBiddingNavigationPreference,
	writeCollectionBiddingNavigationPreference
} from '$lib/bidding-navigation-preferences';

const deployment = vi.hoisted(() => ({ isPublic: false }));
const environment = vi.hoisted(() => ({ browser: false }));
vi.mock('$app/environment', () => ({
	get browser() {
		return environment.browser;
	}
}));
vi.mock('$lib/runtime/public-deployment', () => ({
	get IS_PUBLIC_SINGLE_COLLECTION_DEPLOYMENT() {
		return deployment.isPublic;
	}
}));
afterEach(() => {
	deployment.isPublic = false;
	environment.browser = false;
	vi.unstubAllGlobals();
});

const FILTERS = { selectedTraits: [], selectedTraitRanges: [] };

describe('bidding scope navigation', () => {
	it.each([STATE.Active, POSITION.Losing, PHASE.Paused, null])(
		'retains state %s across collection scope and resumes it without applying defaults',
		(ownStateFilter) => {
			const previous = writeCollectionBiddingNavigationPreference(
				{ bidScope: SCOPE.Traits, ownershipFilter: OWNERSHIP.Own, ownStateFilter },
				null
			);
			const collection = {
				bidScope: SCOPE.Collection,
				ownershipFilter: OWNERSHIP.Own,
				ownStateFilter: null
			};
			const remembered = writeCollectionBiddingNavigationPreference(collection, previous);
			expect(remembered.ownStateFilter).toBe(ownStateFilter);
			for (const bidScope of [SCOPE.Token, SCOPE.Traits]) {
				const href = buildCollectionBiddingScopeHref(
					{ ...FILTERS, ...collection, basePath: '/collection' },
					bidScope,
					remembered
				);
				const query = new URL(href, 'https://example.test').searchParams;
				expect(query.get(PARAM.BidScope)).toBe(bidScope);
				expect(query.get(PARAM.OwnState)).toBe(ownStateFilter);
				expect(query.get(PARAM.Ownership)).toBe(OWNERSHIP.Own);
			}
		}
	);

	it('lets an explicit reset replace an older selection before the round trip', () => {
		const current = { bidScope: SCOPE.Token, ownStateFilter: null };
		const remembered = writeCollectionBiddingNavigationPreference(current, {
			bidScope: SCOPE.Traits,
			ownStateFilter: STATE.Active
		});
		expect(remembered.ownStateFilter).toBeNull();
		const href = buildCollectionBiddingScopeHref(
			{ ...FILTERS, ...current, basePath: '/collection' },
			SCOPE.Traits,
			{ ownStateFilter: STATE.Active }
		);
		expect(new URL(href, 'https://example.test').searchParams.has(PARAM.OwnState)).toBe(false);
	});

	it('leaves a fresh collection view without a remembered state unfiltered on scope changes', () => {
		const current = { bidScope: SCOPE.Collection, ownStateFilter: null };
		const remembered = writeCollectionBiddingNavigationPreference(current, null);
		expect(remembered.ownStateFilter).toBeUndefined();
		const href = buildCollectionBiddingScopeHref(
			{ ...FILTERS, ...current, basePath: '/collection' },
			SCOPE.Token,
			remembered
		);
		const query = new URL(href, 'https://example.test').searchParams;
		expect(query.has(PARAM.Ownership)).toBe(false);
		expect(query.has(PARAM.OwnState)).toBe(false);
	});

	it('omits unsupported state from collection URLs while retaining other current controls', () => {
		const href = buildCollectionBiddingScopeHref(
			{
				...FILTERS,
				selectedTraits: [{ key: 'Mode', value: 'Terrain' }],
				basePath: '/collection',
				bidScope: SCOPE.Traits,
				ownStateFilter: STATE.Active,
				showMuted: true
			},
			SCOPE.Collection,
			null
		);
		const query = new URL(href, 'https://example.test').searchParams;
		expect(query.has(PARAM.OwnState)).toBe(false);
		expect(query.getAll('traits')).toEqual(['Mode:Terrain']);
		expect(query.get(PARAM.ShowMuted)).toBe('true');
	});

	it('keeps public scope navigation free of private controls even with remembered selections', () => {
		deployment.isPublic = true;
		const current = {
			bidScope: SCOPE.Collection,
			ownershipFilter: OWNERSHIP.Own,
			ownStateFilter: null
		};
		const previous = { ownStateFilter: STATE.Active };
		expect(writeCollectionBiddingNavigationPreference(current, previous)).toEqual({
			bidScope: SCOPE.Collection
		});
		const href = buildCollectionBiddingScopeHref(
			{ ...FILTERS, ...current, basePath: '/collection' },
			SCOPE.Traits,
			previous
		);
		const query = new URL(href, 'https://example.test').searchParams;
		expect(query.has(PARAM.Ownership)).toBe(false);
		expect(query.has(PARAM.OwnState)).toBe(false);
	});
});

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
	it.each([SCOPE.Token, SCOPE.Traits])(
		'initializes fresh direct %s entry to My bids and active without changing other controls',
		(bidScope) => {
			const input = new URLSearchParams({
				[PARAM.BidScope]: bidScope,
				[COLLECTION_MEDIA_QUERY_PARAMS.MediaMode]: COLLECTION_MEDIA_MODES.Snapshot,
				traits: 'Mode:Terrain',
				[PARAM.ShowMuted]: 'true'
			});
			const query = applyCollectionBiddingNavigationPreferenceToQuery(input, null);
			expect(query.get(PARAM.Ownership)).toBe(OWNERSHIP.Own);
			expect(query.get(PARAM.OwnState)).toBe(STATE.Active);
			expect(query.get(PARAM.BidScope)).toBe(bidScope);
			expect(query.get(COLLECTION_MEDIA_QUERY_PARAMS.MediaMode)).toBe(
				COLLECTION_MEDIA_MODES.Snapshot
			);
			expect(query.getAll('traits')).toEqual(['Mode:Terrain']);
			expect(query.get(PARAM.ShowMuted)).toBe('true');
			expect(input.has(PARAM.Ownership)).toBe(false);
			expect(input.has(PARAM.OwnState)).toBe(false);
		}
	);
	it('uses the same fresh defaults on bare route entry and main Offers navigation', () => {
		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(new URLSearchParams(), null).toString()
		).toBe(buildCollectionBiddingNavigationQuery(FILTERS, null).toString());
	});

	it.each([
		new URLSearchParams({ [PARAM.OwnState]: POSITION.Losing }),
		new URLSearchParams({ [PARAM.Ownership]: OWNERSHIP.Own }),
		new URLSearchParams({ [PARAM.Maker]: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })
	])('keeps explicit bidder/state filtering authoritative for %s', (input) => {
		expect(applyCollectionBiddingNavigationPreferenceToQuery(input, null).toString()).toBe(
			input.toString()
		);
	});

	it('keeps a remembered All-bids and reset choice unfiltered on direct entry', () => {
		const input = new URLSearchParams({ [PARAM.BidScope]: SCOPE.Traits });
		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(input, {
				bidScope: SCOPE.Token,
				ownershipFilter: null,
				ownStateFilter: null
			}).toString()
		).toBe(input.toString());
	});

	it('does not initialize private filters in public direct entry', () => {
		deployment.isPublic = true;
		const input = new URLSearchParams({ [PARAM.BidScope]: SCOPE.Traits });
		expect(applyCollectionBiddingNavigationPreferenceToQuery(input, null).toString()).toBe(
			input.toString()
		);
	});

	it('adds stored bid scope when URL omits it', () => {
		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(
				new URLSearchParams('traits=Mode%3ATerrain'),
				{
					bidScope: 'traits'
				}
			).toString()
		).toBe('traits=Mode%3ATerrain&bid_scope=traits&ownership=own&own_state=active');

		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(new URLSearchParams(), {
				bidScope: 'traits'
			}).toString()
		).toBe('bid_scope=traits&ownership=own&own_state=active');
	});

	it('keeps explicit URL bid scope ahead of stored values', () => {
		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(
				new URLSearchParams('bid_scope=collection'),
				{
					bidScope: 'traits'
				}
			).toString()
		).toBe('bid_scope=collection&ownership=own');
	});

	it('omits stored default values from the generated URL', () => {
		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(new URLSearchParams(), {
				bidScope: 'token'
			}).toString()
		).toBe('ownership=own&own_state=active');
	});

	it('persists non-default collection scope explicitly', () => {
		expect(
			applyCollectionBiddingNavigationPreferenceToQuery(new URLSearchParams(), {
				bidScope: 'collection'
			}).toString()
		).toBe('bid_scope=collection&ownership=own');
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

	it('retains reset and All-bids navigation if storage cannot write, then resumes persistence', () => {
		environment.browser = true;
		let stored = JSON.stringify({
			bidScope: SCOPE.Traits,
			ownershipFilter: OWNERSHIP.Own,
			ownStateFilter: STATE.Active
		});
		let writesFail = true;
		vi.stubGlobal('window', {
			localStorage: {
				getItem: () => stored,
				setItem: (_key: string, value: string) => {
					if (writesFail) throw new Error('Storage unavailable');
					stored = value;
				}
			}
		});
		const reset = { bidScope: SCOPE.Traits, ownershipFilter: null, ownStateFilter: null };
		writeCollectionBiddingNavigationPreference(reset);
		expect(readCollectionBiddingNavigationPreference()).toEqual(reset);
		const query = applyCollectionBiddingNavigationPreferenceToQuery(
			new URLSearchParams(),
			readCollectionBiddingNavigationPreference()
		);
		expect(query.has(PARAM.Ownership)).toBe(false);
		expect(query.has(PARAM.OwnState)).toBe(false);
		expect(buildCollectionBiddingNavigationQuery(FILTERS).has(PARAM.OwnState)).toBe(false);
		writesFail = false;
		writeCollectionBiddingNavigationPreference(reset);
		stored = JSON.stringify({ bidScope: SCOPE.Token });
		expect(readCollectionBiddingNavigationPreference()).toEqual({ bidScope: SCOPE.Token });
	});
});
