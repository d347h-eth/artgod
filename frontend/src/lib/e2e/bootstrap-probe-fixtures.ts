import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import type { ApiChain, ApiOpenSeaIntegrationStatus } from '../api-types';

// Browser-test route for the bootstrap probe harness page.
export const BOOTSTRAP_PROBE_E2E_ROUTE_PATH = '/e2e-harness/bootstrap-runs';

// Browser-test chain fixture used by the bootstrap-run view.
export const BOOTSTRAP_PROBE_E2E_CHAIN: ApiChain = {
	id: 1,
	type: 'evm',
	publicChainId: 1,
	slug: 'ethereum',
	name: 'Ethereum'
};

// Browser-test OpenSea state keeps optional bootstrap inputs visible.
export const BOOTSTRAP_PROBE_E2E_OPENSEA_INTEGRATION: ApiOpenSeaIntegrationStatus = {
	enabled: true,
	mode: 'enabled',
	reason: null,
	missingKeys: [],
	requiredKeys: []
};

// Feeds deterministic data into the production bootstrap-run view for browser tests.
export function buildBootstrapProbeE2ePageData() {
	return {
		chain: BOOTSTRAP_PROBE_E2E_CHAIN,
		page: {
			items: [],
			nextCursor: null,
			limit: DEFAULT_PAGE_LIMIT
		},
		status: '',
		basePath: BOOTSTRAP_PROBE_E2E_ROUTE_PATH,
		openseaIntegration: BOOTSTRAP_PROBE_E2E_OPENSEA_INTEGRATION
	};
}
