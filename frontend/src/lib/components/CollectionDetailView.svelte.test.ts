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
					collectionId: 1,
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
							listingPrice: '500000000000000000',
							listingCurrency: '0x0000000000000000000000000000000000000000',
							attributes: [{ key: 'Hat', value: 'Beanie' }],
							hasMetadata: true,
							metadataUpdatedAt: '2026-01-01T00:00:00Z'
						}
					],
					prevCursor: null,
					nextCursor: null,
					limit: 25,
					totalItems: 1,
					rangeStart: 1,
					rangeEnd: 1,
					currentPage: 1,
					totalPages: 1
				},
				facets: [{ key: 'Hat', values: [{ value: 'Beanie', tokenCount: 1 }] }],
				selectedTraits: [{ key: 'Hat', value: 'Beanie' }],
				basePath: '/ethereum/milady',
				requestCursor: null,
				tokenStatus: 'listed',
				displayMode: 'grid'
			}
		});

		expect(body).toContain('tokens');
		expect(body).toContain('/ethereum/milady/activity?limit=25&amp;kind=sales&amp;traits=Hat%3ABeanie');
		expect(body).toContain('only listed');
		expect(body).toContain('show all');
		expect(body).toContain('/ethereum/milady?limit=25&amp;mode=grid&amp;token_status=all&amp;traits=Hat%3ABeanie');
		expect(body).toContain('<span class="runtime-tab-active">tokens</span>');
		expect(body).toContain('<span class="secondary-tab-active">grid</span>');
		expect(body).toContain('/ethereum/milady?limit=25&amp;mode=table&amp;token_status=listed&amp;traits=Hat%3ABeanie');
		expect(body).toContain('>traits<');
		expect(body).toContain('>reset<');
		expect(body).toContain('1 listed');
		expect(body).toContain('token 1');
		expect(body).toContain('0.5 ETH');
		expect(body).toContain(
			'https://opensea.io/item/ethereum/0x1111111111111111111111111111111111111111/1'
		);
		expect(body).toContain('Beanie');
	});
});
