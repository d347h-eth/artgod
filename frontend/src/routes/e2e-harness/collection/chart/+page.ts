import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import { buildBiddingE2eCollectionDetailData } from '$lib/e2e/bidding-automation-fixtures';
import { getDefaultBlockExplorerConfig } from '@artgod/shared/config/block-explorer';
import type { PageLoad } from './$types';
export const ssr = false;
export const load: PageLoad = ({ url }) => {
	if (!dev) throw error(404, 'Not found');
	const data = buildBiddingE2eCollectionDetailData(url.searchParams);
	return { ...data, blockExplorer: getDefaultBlockExplorerConfig() };
};
