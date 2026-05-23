import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { buildBiddingE2eCollectionBiddingData } from '$lib/e2e/bidding-automation-fixtures';

export const ssr = false;

export const load: PageLoad = ({ url }) => {
	if (!dev) {
		throw error(404, 'Not found');
	}

	// Feed deterministic bid-book data into the production collection bidding view.
	return buildBiddingE2eCollectionBiddingData(url.searchParams);
};
