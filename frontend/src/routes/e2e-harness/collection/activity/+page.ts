import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import { buildListingHistoryFixture } from '$lib/e2e/listing-history-fixture';
import type { PageLoad } from './$types';

export const ssr = false;
export const load: PageLoad = ({ url }) => {
	if (!dev) throw error(404, 'Not found');
	return buildListingHistoryFixture(url.searchParams);
};
