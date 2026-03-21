import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import HolderTokensView from './HolderTokensView.svelte';

describe('HolderTokensView', () => {
	it('renders holder-scoped browser chrome and mixed held summary', () => {
		const { body } = render(HolderTokensView, {
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
					totalItems: 2,
					rangeStart: 1,
					rangeEnd: 1,
					currentPage: 1,
					totalPages: 2
				},
				facets: [{ key: 'Hat', values: [{ value: 'Beanie', tokenCount: 1 }] }],
				selectedTraits: [],
				collectionBasePath: '/ethereum/milady',
				holdersBasePath: '/ethereum/milady/holders',
				browserBasePath: '/ethereum/milady/holders/0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				owner: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				requestCursor: null,
				displayMode: 'grid'
			}
		});

		expect(body).toContain('tokens currently held by');
		expect(body).toContain('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		expect(body).toContain('/ethereum/milady/activity?kind=sales');
		expect(body).toContain('/ethereum/milady/holders');
		expect(body).toContain('2 held');
		expect(body).not.toContain('only listed');
	});
});
