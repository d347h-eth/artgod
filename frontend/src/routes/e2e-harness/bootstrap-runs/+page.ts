import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { buildBootstrapProbeE2ePageData } from '$lib/e2e/bootstrap-probe-fixtures';

export const ssr = false;

// Query key used only by the bootstrap probe E2E harness.
const BOOTSTRAP_PROBE_E2E_OPENSEA_QUERY_PARAM = 'opensea';

export const load: PageLoad = ({ url }) => {
	if (!dev) {
		throw error(404, 'Not found');
	}

	// Feed deterministic bootstrap page data into the production bootstrap view.
	return buildBootstrapProbeE2ePageData({
		openseaEnabled: url.searchParams.get(BOOTSTRAP_PROBE_E2E_OPENSEA_QUERY_PARAM) !== 'disabled'
	});
};
