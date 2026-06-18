import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { buildBootstrapProbeE2ePageData } from '$lib/e2e/bootstrap-probe-fixtures';

export const ssr = false;

export const load: PageLoad = () => {
	if (!dev) {
		throw error(404, 'Not found');
	}

	// Feed deterministic bootstrap page data into the production bootstrap view.
	return buildBootstrapProbeE2ePageData();
};
