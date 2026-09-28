import { dev } from '$app/environment';
import { error } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import {
	buildBootstrapProbeE2ePageData,
	BOOTSTRAP_PROBE_E2E_CHAINS,
	BOOTSTRAP_PROBE_E2E_CHAIN_QUERY_PARAM
} from '$lib/e2e/bootstrap-probe-fixtures';

export const ssr = false;

// Query key used only by the bootstrap probe E2E harness.
const BOOTSTRAP_PROBE_E2E_OPENSEA_QUERY_PARAM = 'opensea';

export const load: PageLoad = ({ url }) => {
	if (!dev) {
		throw error(404, 'Not found');
	}

	const chainSlug = url.searchParams.get(BOOTSTRAP_PROBE_E2E_CHAIN_QUERY_PARAM);
	const chain = BOOTSTRAP_PROBE_E2E_CHAINS.find((candidate) => candidate.slug === chainSlug);
	if (chainSlug && !chain) throw error(404, 'Unknown test chain');
	// Feed deterministic bootstrap page data into the production bootstrap view.
	return {
		...buildBootstrapProbeE2ePageData({
			chain,
			openseaEnabled: url.searchParams.get(BOOTSTRAP_PROBE_E2E_OPENSEA_QUERY_PARAM) !== 'disabled'
		}),
		chainSwitchChoices: chainSlug ? BOOTSTRAP_PROBE_E2E_CHAINS : []
	};
};
