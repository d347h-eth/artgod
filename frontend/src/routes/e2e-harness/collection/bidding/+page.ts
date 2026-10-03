import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import { ReadModelBadRequestError } from '@artgod/shared/read-models/errors';
import { assertBidScopeSupportsOwnStateFilter } from '@artgod/shared/trading/bid-book-own-state';
import {
	parseBidBookOwnStateFilter,
	parseCollectionBiddingBidScopeFilter
} from '$lib/bidding-query';
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
		activeScenario = url.searchParams.get(BIDDING_E2E_SCENARIO_QUERY_PARAM);
	}
	const searchParams = new URLSearchParams(url.searchParams);
	if (activeScenario) {
		searchParams.set(BIDDING_E2E_SCENARIO_QUERY_PARAM, activeScenario);
	}

	// Feed deterministic bid-book data into the production collection bidding view.
	return buildBiddingE2eCollectionBiddingData(searchParams);
};
