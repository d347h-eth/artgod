import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import {
	buildListingHistoryFixture,
	buildSaleHistoryFixture
} from '$lib/e2e/listing-history-fixture';
import { LISTING_HISTORY_HARNESS } from '$lib/e2e/listing-history-contract';
import type { PageLoad } from './$types';

export const ssr = false;
export const load: PageLoad = ({ url }) => {
	if (!dev) throw error(404, 'Not found');
	return url.searchParams.has(LISTING_HISTORY_HARNESS.salesKey)
		? buildSaleHistoryFixture()
		: buildListingHistoryFixture(url.searchParams);
};
