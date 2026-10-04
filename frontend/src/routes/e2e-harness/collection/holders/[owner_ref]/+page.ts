import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { buildBiddingE2eHolderTokensData } from '$lib/e2e/bidding-automation-fixtures';

export const ssr = false;

export const load: PageLoad = ({ url, params }) => {
	if (!dev) {
		throw error(404, 'Not found');
	}

	return buildBiddingE2eHolderTokensData(url.searchParams, params.owner_ref);
};
