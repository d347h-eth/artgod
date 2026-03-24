import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
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
						extensionConfig: { template: 'L{Level}/B{Biome}/{Zone}' },
						effectiveConfig: { template: 'L{Level}/B{Biome}/{Zone}' }
					},
					activityRowTraitSummaryTemplate: {
						selectedSource: 'extension',
						userConfig: { template: '' },
						extensionConfig: { template: 'L{Level}/B{Biome}/{Zone}' },
						effectiveConfig: { template: 'L{Level}/B{Biome}/{Zone}' }
					}
				},
				basePath: '/ethereum/terraforms',
				selectedTraits: [],
				selectedTraitRanges: [],
				mediaMode: 'artifact'
			}
		});

		expect(body).toContain('trait filter presentation');
		expect(body).toContain('token card trait summary template');
		expect(body).toContain('activity row trait summary template');
		expect(body).toContain('user-defined');
		expect(body).toContain('extension-defined');
		expect(body).toContain('L{Level}/B{Biome}/{Zone}');
		expect(body).toContain('placeholder="empty = hidden"');
		expect(body).toContain('>save<');
	});
});
