import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { buildBiddingE2eTokenDetailData } from '$lib/e2e/bidding-automation-fixtures';

export const ssr = false;

export const load: PageLoad = ({ params, url }) => {
	if (!dev) {
		throw error(404, 'Not found');
	}

	// Feed deterministic token-detail data into the production token detail page.
	return buildBiddingE2eTokenDetailData(params.token_ref, url.searchParams);
};
