import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import {
	BIDDING_E2E_SCENARIO_QUERY_PARAM,
	buildBiddingE2eCollectionBiddingData
} from '$lib/e2e/bidding-automation-fixtures';

export const ssr = false;

// This client-only harness retains its selected fixture across production links,
// which intentionally rebuild only production query parameters.
let activeScenario: string | null = null;

export const load: PageLoad = ({ url }) => {
	if (!dev) {
		throw error(404, 'Not found');
	}

	if (url.searchParams.has(BIDDING_E2E_SCENARIO_QUERY_PARAM)) {
		activeScenario = url.searchParams.get(BIDDING_E2E_SCENARIO_QUERY_PARAM);
	}
	const searchParams = new URLSearchParams(url.searchParams);
	if (activeScenario) {
		searchParams.set(BIDDING_E2E_SCENARIO_QUERY_PARAM, activeScenario);
	}

	// Feed deterministic bid-book data into the production collection bidding view.
	return buildBiddingE2eCollectionBiddingData(searchParams);
};
