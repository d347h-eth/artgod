import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { TERRAFORMS_TRAIT_SUMMARY_TEMPLATE } from '@artgod/shared/extensions/terraforms';
import {
	COLLECTION_MEDIA_MODES,
	COLLECTION_MEDIA_PREFERENCE_VALUES
} from '@artgod/shared/extensions';
import { IMAGE_CACHE_MODE } from '@artgod/shared/media/token-image-cache';
import { COLLECTION_MEDIA_SOURCE, defaultMediaPurposePolicyConfig } from '@artgod/shared/types';
import CollectionCustomizationView from './CollectionCustomizationView.svelte';

describe('CollectionCustomizationView', () => {
	it('renders trait presentation and summary-template controls', () => {
		const { body } = render(CollectionCustomizationView, {
			props: {
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
					address: '0x2222222222222222222222222222222222222222',
					standard: 'erc721',
					status: 'live',
					deploymentBlock: 1,
					bootstrapAnchorBlock: null,
					createdAt: '2026-01-01T00:00:00Z',
					updatedAt: '2026-01-01T00:00:00Z'
				},
				customization: {
					traitFilterPresentation: {
						selectedSource: 'extension',
						userConfig: { rangeKeys: [] },
						extensionConfig: { rangeKeys: ['???'] },
						effectiveConfig: { rangeKeys: ['???'] },
						availableTraitKeys: ['???', 'Level']
					},
					tokenCardTraitSummaryTemplate: {
						selectedSource: 'extension',
						userConfig: { template: '' },
						extensionConfig: { template: TERRAFORMS_TRAIT_SUMMARY_TEMPLATE },
						effectiveConfig: { template: TERRAFORMS_TRAIT_SUMMARY_TEMPLATE }
					},
					activityRowTraitSummaryTemplate: {
						selectedSource: 'extension',
						userConfig: { template: '' },
						extensionConfig: { template: TERRAFORMS_TRAIT_SUMMARY_TEMPLATE },
						effectiveConfig: { template: TERRAFORMS_TRAIT_SUMMARY_TEMPLATE }
					},
					imageCachePolicy: {
						selectedSource: 'extension',
						userConfig: {
							imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
							maxDimension: 512
						},
						extensionConfig: {
							imageCacheMode: IMAGE_CACHE_MODE.Off,
							maxDimension: null
						},
						effectiveConfig: {
							imageCacheMode: IMAGE_CACHE_MODE.Off,
							maxDimension: null
						}
					},
					mediaPurposePolicy: {
						selectedSource: 'extension',
						userConfig: defaultMediaPurposePolicyConfig(),
						extensionConfig: {
							tokenCard: COLLECTION_MEDIA_SOURCE.Image,
							fullscreenPreview: COLLECTION_MEDIA_SOURCE.AnimationUrl,
							tokenDetail: COLLECTION_MEDIA_SOURCE.AnimationUrl
						},
						effectiveConfig: {
							tokenCard: COLLECTION_MEDIA_SOURCE.Image,
							fullscreenPreview: COLLECTION_MEDIA_SOURCE.AnimationUrl,
							tokenDetail: COLLECTION_MEDIA_SOURCE.AnimationUrl
						}
					}
				},
				basePath: '/ethereum/terraforms',
				selectedTraits: [],
				selectedTraitRanges: [],
				mediaMode: COLLECTION_MEDIA_MODES.Snapshot,
				mediaPreference: COLLECTION_MEDIA_PREFERENCE_VALUES.Disabled
			}
		});

		expect(body).toContain('trait filter presentation');
		expect(body).toContain('image cache policy');
		expect(body).toContain('media purpose policy');
		expect(body).toContain('token card trait summary template');
		expect(body).toContain('activity row trait summary template');
		expect(body).toContain('user-defined');
		expect(body).toContain('extension-defined');
		expect(body).toContain(TERRAFORMS_TRAIT_SUMMARY_TEMPLATE);
		expect(body).toContain('<textarea');
		expect(body).toContain('placeholder="empty = hidden"');
		expect(body).toContain('>save<');
		expect(body).toContain('media_preference=disabled');
	});
});
