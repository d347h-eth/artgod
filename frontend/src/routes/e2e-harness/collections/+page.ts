import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { buildCollectionOpenSeaSyncE2ePageData } from '$lib/e2e/collection-opensea-sync-fixtures';

export const ssr = false;

export const load: PageLoad = () => {
	if (!dev) {
		throw error(404, 'Not found');
	}

	// Feed deterministic collection data into the production collection-list view.
	return buildCollectionOpenSeaSyncE2ePageData();
};
