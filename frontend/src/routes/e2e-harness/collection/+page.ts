import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { buildBiddingE2eCollectionDetailData } from '$lib/e2e/bidding-automation-fixtures';

export const ssr = false;

export const load: PageLoad = ({ url }) => {
	if (!dev) {
		throw error(404, 'Not found');
	}

	// Feed deterministic token-browser data into the production collection view.
	return buildBiddingE2eCollectionDetailData(url.searchParams);
};
