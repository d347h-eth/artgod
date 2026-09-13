import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import {
	buildCollectionOpenSeaSyncE2ePageData,
	COLLECTION_OPENSEA_SYNC_E2E_SETUP_STATE
} from '$lib/e2e/collection-opensea-sync-fixtures';

export const ssr = false;

export const load: PageLoad = ({ url }) => {
	if (!dev) {
		throw error(404, 'Not found');
	}

	// Feed deterministic collection data into the production collection-list view.
	if (
		url.searchParams.get(COLLECTION_OPENSEA_SYNC_E2E_SETUP_STATE.QueryParam) ===
		COLLECTION_OPENSEA_SYNC_E2E_SETUP_STATE.Unavailable
	) {
		return buildCollectionOpenSeaSyncE2ePageData(null);
	}
	return buildCollectionOpenSeaSyncE2ePageData();
};
