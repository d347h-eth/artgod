import { DEFAULT_PAGE_LIMIT } from '@artgod/shared/config/pagination';
import {
	COLLECTION_STANDARD,
	COLLECTION_STATUS,
	OPENSEA_COLLECTION_STATUS,
	OPENSEA_STREAM_INGESTION_STATUS
} from '@artgod/shared/types';
import type { ApiChain, ApiCollection, ApiOpenSeaIntegrationStatus } from '../api-types';

// Browser-test route for the collection-list OpenSea sync journey.
export const COLLECTION_OPENSEA_SYNC_E2E_ROUTE_PATH = '/e2e-harness/collections';

// Browser-test collection reproduces a shared Art Blocks token-range collection.
export const COLLECTION_OPENSEA_SYNC_E2E_COLLECTION: ApiCollection = {
	chainId: 1,
	collectionId: 16,
	slug: 'gumbo',
	address: '0x99a9b7c1116f9ceeb1652de04d5969cce509b069',
	standard: COLLECTION_STANDARD.Erc721,
	status: COLLECTION_STATUS.Live,
	openseaSlug: null,
	openseaStatus: OPENSEA_COLLECTION_STATUS.Failed,
	openseaReadyAt: null,
	openseaStreamIngestionStatus: OPENSEA_STREAM_INGESTION_STATUS.Enabled,
	deploymentBlock: 12_000_000,
	bootstrapAnchorBlock: 20_000_000,
	createdAt: '2026-07-01T00:00:00Z',
	updatedAt: '2026-07-01T00:00:00Z',
	tokenScope: {
		label: 'token range',
		items: [
			{ label: 'scope', value: 'token range' },
			{ label: 'start token', value: '462000000' },
			{ label: 'total supply', value: '400' }
		]
	}
};

// OpenSea slug expected for the shared-contract fixture collection.
export const COLLECTION_OPENSEA_SYNC_E2E_SLUG = 'gumbo-by-mathias-isaksen';

export const COLLECTION_OPENSEA_SYNC_E2E_CHAIN: ApiChain = {
	id: 1,
	type: 'evm',
	publicChainId: 1,
	slug: 'ethereum',
	name: 'Ethereum'
};

const COLLECTION_OPENSEA_SYNC_E2E_INTEGRATION: ApiOpenSeaIntegrationStatus = {
	enabled: true,
	mode: 'enabled',
	reason: null,
	missingKeys: [],
	requiredKeys: []
};

// Feeds the production collections view with one eligible shared-contract collection.
export function buildCollectionOpenSeaSyncE2ePageData() {
	return {
		chain: COLLECTION_OPENSEA_SYNC_E2E_CHAIN,
		page: {
			items: [COLLECTION_OPENSEA_SYNC_E2E_COLLECTION],
			nextCursor: null,
			limit: DEFAULT_PAGE_LIMIT
		},
		status: '',
		basePath: COLLECTION_OPENSEA_SYNC_E2E_ROUTE_PATH,
		openseaIntegration: COLLECTION_OPENSEA_SYNC_E2E_INTEGRATION
	};
}
