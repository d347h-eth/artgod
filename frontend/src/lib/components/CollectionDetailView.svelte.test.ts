import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import CollectionDetailView from './CollectionDetailView.svelte';

describe('CollectionDetailView', () => {
	it('renders token rows and trait facets', () => {
		const { body } = render(CollectionDetailView, {
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
					collectionId: 'milady-main',
					slug: 'milady',
					address: '0x1111111111111111111111111111111111111111',
					standard: 'erc721',
					status: 'live',
					deploymentBlock: 1,
					bootstrapAnchorBlock: null,
					createdAt: '2026-01-01T00:00:00Z',
					updatedAt: '2026-01-01T00:00:00Z'
				},
				tokens: {
					items: [
						{
							tokenId: '1',
							name: 'Milady #1',
							image: 'https://example.com/1.png',
							attributes: [{ key: 'Hat', value: 'Beanie' }],
							hasMetadata: true,
							metadataUpdatedAt: '2026-01-01T00:00:00Z'
						}
					],
					nextCursor: null,
					limit: 25
				},
				facets: [{ key: 'Hat', values: [{ value: 'Beanie', tokenCount: 1 }] }],
				selectedTraits: [{ key: 'Hat', value: 'Beanie' }],
				basePath: '/ethereum/milady'
			}
		});

		expect(body).toContain('Collection Browser');
		expect(body).toContain('Milady #1');
		expect(body).toContain('Beanie');
	});
});
