import { dev } from '$app/environment';
import { error, redirect } from '@sveltejs/kit';
import { ReadModelBadRequestError } from '@artgod/shared/read-models/errors';
import { assertBidScopeSupportsOwnStateFilter } from '@artgod/shared/trading/bid-book-own-state';
import {
	parseBidBookOwnStateFilter,
	parseCollectionBiddingBidScopeFilter
} from '$lib/bidding-query';
import type { PageLoad } from './$types';
import { resolvePreferredCollectionBiddingNavigationHref } from '$lib/bidding-navigation-preferences';
import {
	readQueryControlPreference,
	writeQueryControlPreference,
	type QueryControlPreferenceDefinitions
} from '$lib/query-control-preferences';
import {
	BIDDING_E2E_SCENARIO,
	BIDDING_E2E_SCENARIO_QUERY_PARAM,
	buildBiddingE2eCollectionBiddingData,
	parseBiddingE2eScenario,
	type BiddingE2eScenario
} from '$lib/e2e/bidding-automation-fixtures';

export const ssr = false;

type ScenarioPreference = { scenario: BiddingE2eScenario | null };
const SCENARIO_STORAGE_KEY = 'artgod.e2e.bidding-scenario';
const SCENARIO_PREFERENCE_DEFINITIONS: QueryControlPreferenceDefinitions<ScenarioPreference> = {
	scenario: {
		param: BIDDING_E2E_SCENARIO_QUERY_PARAM,
		values: [null, ...Object.values(BIDDING_E2E_SCENARIO)]
	}
};

// Production links omit harness query parameters. Session storage retains the
// selected fixture across reloads; module state also supports client navigation.
let activeScenario: BiddingE2eScenario | null = null;

export const load: PageLoad = ({ url }) => {
	if (!dev) {
		throw error(404, 'Not found');
	}
	// Exercise the production route-entry policy before composing fixture data.
	const preferredHref = resolvePreferredCollectionBiddingNavigationHref(url);
	if (preferredHref) {
		throw redirect(307, preferredHref);
	}
	// Reuse production scope validation before rendering synthetic bid-book data.
	// The harness maps domain failure to the same HTTP error as the backend read.
	if (parseBidBookOwnStateFilter(url.searchParams)) {
		try {
			assertBidScopeSupportsOwnStateFilter(parseCollectionBiddingBidScopeFilter(url.searchParams));
		} catch (cause) {
			if (cause instanceof ReadModelBadRequestError) {
				throw error(400, cause.message);
			}
			throw cause;
		}
	}

	if (url.searchParams.has(BIDDING_E2E_SCENARIO_QUERY_PARAM)) {
		activeScenario = parseBiddingE2eScenario(url.searchParams);
		writeQueryControlPreference({
			storageKey: SCENARIO_STORAGE_KEY,
			definitions: SCENARIO_PREFERENCE_DEFINITIONS,
			preference: { scenario: activeScenario },
			storage: window.sessionStorage
		});
	} else {
		activeScenario =
			readQueryControlPreference<ScenarioPreference>({
				storageKey: SCENARIO_STORAGE_KEY,
				definitions: SCENARIO_PREFERENCE_DEFINITIONS,
				storage: window.sessionStorage
			})?.scenario ?? activeScenario;
	}
	const searchParams = new URLSearchParams(url.searchParams);
	if (activeScenario) {
		searchParams.set(BIDDING_E2E_SCENARIO_QUERY_PARAM, activeScenario);
	}

	// Feed deterministic bid-book data into the production collection bidding view.
	return buildBiddingE2eCollectionBiddingData(searchParams);
};
