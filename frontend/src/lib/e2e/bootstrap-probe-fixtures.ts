import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import { OPENSEA_API_KEY_ENV } from '@artgod/shared/config/opensea-integration';
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

// Browser-test OpenSea state exercises disabled bootstrap inputs.
export const BOOTSTRAP_PROBE_E2E_DISABLED_OPENSEA_INTEGRATION: ApiOpenSeaIntegrationStatus = {
	enabled: false,
	mode: 'auto',
	reason: `OpenSea integration disabled because ${OPENSEA_API_KEY_ENV} is not configured`,
	missingKeys: [OPENSEA_API_KEY_ENV],
	requiredKeys: [OPENSEA_API_KEY_ENV]
};

// Feeds deterministic data into the production bootstrap-run view for browser tests.
export function buildBootstrapProbeE2ePageData(input: { openseaEnabled?: boolean } = {}) {
	return {
		chain: BOOTSTRAP_PROBE_E2E_CHAIN,
		page: {
			items: [],
			nextCursor: null,
			limit: DEFAULT_PAGE_LIMIT
		},
		status: '',
		basePath: BOOTSTRAP_PROBE_E2E_ROUTE_PATH,
		openseaIntegration:
			input.openseaEnabled === false
				? BOOTSTRAP_PROBE_E2E_DISABLED_OPENSEA_INTEGRATION
				: BOOTSTRAP_PROBE_E2E_OPENSEA_INTEGRATION
	};
}
