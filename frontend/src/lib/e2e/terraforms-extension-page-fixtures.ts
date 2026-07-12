import {
	TERRAFORMS_EXTENSION_KEY,
	TERRAFORMS_EXTENSION_PAGE_REFS,
	TERRAFORMS_MEDIA_MODE_OPTIONS,
	TERRAFORMS_MEDIA_PREFERENCE_DEFAULT_ENABLED,
	TERRAFORMS_MEDIA_PREFERENCE_LABEL
} from '@artgod/shared/extensions/terraforms';
import { getDefaultBlockExplorerConfig } from '@artgod/shared/config/block-explorer';
import { COLLECTION_MEDIA_MODE_OPTIONS, COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
import type { CollectionExtensionPageLoadResult } from '$lib/collection-extension-pages/page-load';

const TERRAFORMS_E2E_FIXTURE_NOW = '2026-05-24T00:00:00Z';
const TERRAFORMS_E2E_COLLECTION_BASE_PATH = '/e2e-harness/collection';

// Builds deterministic Terraforms extension-page data for the Playwright harness.
export function buildTerraformsExtensionPageE2eData(): CollectionExtensionPageLoadResult {
	return {
		chain: {
			id: 1,
			type: 'evm',
			publicChainId: 1,
			slug: 'ethereum',
			name: 'Ethereum'
		},
		collection: {
			chainId: 1,
			collectionId: 1,
			slug: 'terraforms',
			address: '0x4E1f41613c9084FdB9E34E11fAE9412427480e56',
			standard: 'erc721',
			status: 'live',
			deploymentBlock: 13_823_015,
			bootstrapAnchorBlock: null,
			createdAt: TERRAFORMS_E2E_FIXTURE_NOW,
			updatedAt: TERRAFORMS_E2E_FIXTURE_NOW,
			extensions: [{ key: TERRAFORMS_EXTENSION_KEY }],
			activityEventFeeds: []
		},
		media: {
			selectedMode: COLLECTION_MEDIA_MODES.Snapshot,
			defaultMode: COLLECTION_MEDIA_MODES.Snapshot,
			availableModes: [
				COLLECTION_MEDIA_MODE_OPTIONS.Snapshot,
				TERRAFORMS_MEDIA_MODE_OPTIONS.Live
			],
			preference: {
				label: TERRAFORMS_MEDIA_PREFERENCE_LABEL,
				enabled: TERRAFORMS_MEDIA_PREFERENCE_DEFAULT_ENABLED,
				defaultEnabled: TERRAFORMS_MEDIA_PREFERENCE_DEFAULT_ENABLED
			}
		},
		basePath: TERRAFORMS_E2E_COLLECTION_BASE_PATH,
		page: {
			extensionKey: TERRAFORMS_EXTENSION_KEY,
			pageRef: TERRAFORMS_EXTENSION_PAGE_REFS.Hypercastle
		},
		blockExplorer: getDefaultBlockExplorerConfig()
	};
}
